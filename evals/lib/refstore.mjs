/**
 * Reference retrieval engine for the eval harness (NOT shipped core).
 *
 * This is a from-scratch JS implementation of docs/design/03-retrieval.md, used
 * for two purposes:
 *   1. smoke-test the harness end-to-end before @harnmem/core's dist/ exists;
 *   2. provide the A0–A5 ablation ladder (keyword grep → BM25F → signals → links
 *      → MMR/budget) that core's config toggles later reproduce.
 *
 * It deliberately follows 03 §2/§3 formulas exactly (BM25F field weights, CJK
 * bigram tokenizer, min-max lex, diffusion, MMR, abstain gate) so numbers are
 * comparable, but it is *not* the product engine. Run reports label the store.
 *
 * Modes: "grep" (A0) | "bm25" (A1) | "bm25f" (A2) | "signals" (A3) | "links" (A4) | "full" (A5)
 */
const DAY = 86_400_000;

export const DEFAULT_RETRIEVAL = {
  k1: 1.2,
  b: 0.75,
  weights: { lex: 1.0, imp: 0.15, conf: 0.1, rec: 0.12, use: 0.08, pin: 0.25, link: 0.2, stale: 0.3 },
  decayPerHour: 0.995,
  mmrLambda: 0.7,
  abstainLex: 0.15,
  ttlDays: { user: 365, feedback: 365, project: 180, reference: 120 },
  synonyms: true,
  linkDiffusion: true,
  mmr: true,
  fields: { title: 3.0, tags: 2.5, description: 2.0, content: 1.0 },
};
export const BUDGET = { injectTokens: 1200, searchTokens: 1200, hotEntries: 24, maxPinned: 10 };

// --------------------------------------------------------------- tokenizer
/** docs/design/03-retrieval.md §2 — no dictionary, no deps. */
export function tokenize(text) {
  const out = [];
  const nfkc = text.normalize("NFKC").toLowerCase();
  const re = /[\u4e00-\u9fff]+|[a-z0-9_]+/g;
  let m;
  while ((m = re.exec(nfkc))) {
    const t = m[0];
    if (/[\u4e00-\u9fff]/.test(t)) {
      if (t.length === 1) {
        out.push(t);
        continue;
      }
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
      out.push(t[0], t[t.length - 1]);
    } else {
      out.push(t);
    }
  }
  return out;
}
const countTokens = (text) => {
  const m = new Map();
  for (const t of tokenize(text)) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
};

// ------------------------------------------------------------------ rng-free simhash / jaccard
const fnv1a = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
function simhash64(text) {
  const v = new Int32Array(64);
  for (const t of tokenize(text)) {
    const h1 = fnv1a(t);
    const h2 = fnv1a(t + "#");
    for (let b = 0; b < 32; b++) {
      v[b] += (h1 >>> b) & 1 ? 1 : -1;
      v[32 + b] += (h2 >>> b) & 1 ? 1 : -1;
    }
  }
  let lo = 0;
  let hi = 0;
  for (let b = 0; b < 32; b++) {
    if (v[b] > 0) lo |= 1 << b;
    if (v[32 + b] > 0) hi |= 1 << b;
  }
  return [lo >>> 0, hi >>> 0];
}
const hamming64 = (a, b) => {
  let d = 0;
  for (let i = 0; i < 2; i++) {
    let x = (a[i] ^ b[i]) >>> 0;
    while (x) {
      d += x & 1;
      x >>>= 1;
    }
  }
  return d;
};
function char3grams(text) {
  const s = text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  const set = new Set();
  if (s.length < 3) {
    if (s) set.add(s);
    return set;
  }
  for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3));
  return set;
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
function cosineCounts(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  for (const [t, v] of a) if (b.has(t)) dot += v * b.get(t);
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

// --------------------------------------------------------------- utilities
const projectKey = (r) => (r.scope === "user" ? "user" : `project:${r.project ?? ""}`);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ------------------------------------------------------------------ store
export class RefStore {
  /**
   * @param {object} opts
   * @param {"grep"|"bm25"|"bm25f"|"signals"|"links"|"full"} [opts.mode]
   * @param {Partial<typeof DEFAULT_RETRIEVAL>} [opts.config]
   */
  constructor(opts = {}) {
    this.mode = opts.mode ?? "full";
    this.cfg = {
      ...DEFAULT_RETRIEVAL,
      ...opts.config,
      weights: { ...DEFAULT_RETRIEVAL.weights, ...(opts.config?.weights ?? {}) },
      fields: { ...DEFAULT_RETRIEVAL.fields, ...(opts.config?.fields ?? {}) },
      ttlDays: { ...DEFAULT_RETRIEVAL.ttlDays, ...(opts.config?.ttlDays ?? {}) },
    };
    this.name = `ref-js(${this.mode})`;
    this.records = new Map();
    this.order = [];
    this.byKey = new Map(); // record id -> shard key
    this.index = new Map(); // shard -> {postings, df, N, avgLen}
    this.backlinks = new Map();
    this.syn = new Map();
    this.now = Date.now();
    this.home = null;
    this.project = null;
    this.buildMs = 0;
    this.avgLen = 1;
  }

  // -- lifecycle
  async open({ home, project, now } = {}) {
    this.home = home ?? null;
    this.project = project ?? null;
    if (typeof now === "number") this.now = now;
    return this;
  }

  async close() {
    this.records.clear();
    this.index.clear();
  }

  /** Optional synonym table injection (parsed by runner from evals/data/synonyms.zh.tsv). */
  setSynonyms(map) {
    this.syn = map;
    return this;
  }
  /** Optional backlink map injection (links are already on records). */
  setBacklinks() {}

  importRecords(records) {
    const t0 = performance.now();
    this.records.clear();
    this.order = [];
    this.byKey.clear();
    this.index.clear();
    this.backlinks = new Map();
    for (const r of records) {
      const rec = normalizeRecord(r);
      this.records.set(rec.id, rec);
      this.order.push(rec.id);
    }
    this.order.sort();
    if (this.mode !== "grep") this._buildIndex();
    for (const rec of this.records.values()) {
      for (const l of rec.links) {
        if (!this.backlinks.has(l)) this.backlinks.set(l, new Set());
        this.backlinks.get(l).add(rec.id);
      }
    }
    this.buildMs = performance.now() - t0;
    return { imported: this.records.size, ms: this.buildMs };
  }

  _fieldsFor(mode) {
    if (mode === "bm25") return { title: 0, tags: 0, description: 0, content: 1 };
    return this.cfg.fields;
  }

  _buildIndex() {
    const fields = this._fieldsFor(this.mode === "grep" ? "full" : this.mode);
    const fieldsList = Object.keys(fields).filter((f) => fields[f] > 0);
    const perShard = new Map();
    for (const rec of this.records.values()) {
      const key = projectKey(rec);
      let shard = perShard.get(key);
      if (!shard) {
        shard = { postings: new Map(), df: new Map(), N: 0, sumLen: 0, docs: new Map() };
        perShard.set(key, shard);
      }
      const tf = { title: new Map(), tags: new Map(), description: new Map(), content: new Map() };
      const raw = {
        title: rec.title,
        tags: rec.tags.join(" "),
        description: rec.description,
        content: rec.content.slice(0, 8192),
      };
      let len = 0;
      for (const f of fieldsList) {
        const counts = countTokens(raw[f] ?? "");
        tf[f] = counts;
        for (const [t, c] of counts) {
          len += fields[f] * c;
        }
      }
      shard.N++;
      shard.sumLen += len;
      shard.docs.set(rec.id, { len });
      const wtf = new Map();
      for (const f of fieldsList) {
        for (const [t, c] of tf[f]) wtf.set(t, (wtf.get(t) ?? 0) + fields[f] * c);
      }
      for (const [t, c] of wtf) {
        if (!shard.postings.has(t)) shard.postings.set(t, new Map());
        shard.postings.get(t).set(rec.id, c);
        shard.df.set(t, (shard.df.get(t) ?? 0) + 1);
      }
    }
    for (const shard of perShard.values()) shard.avgLen = shard.N ? shard.sumLen / shard.N : 1;
    this.index = perShard;
  }

  // -- filter (03 §3.2)
  _visible(rec, opts) {
    if (opts.includeHistory) {
      if (rec.status === "dropped") return false;
    } else if (rec.status !== "active") return false;
    if (rec.scope === "user") return opts.scope === "all" || opts.scope === "user" || opts.scope === "project";
    if (opts.scope === "user") return false;
    if (opts.project && rec.project && rec.project !== opts.project) return false;
    if (opts.project && !rec.project) return false;
    return true;
  }

  _shardsFor(opts) {
    const keys = [];
    if (opts.scope === "user") return ["user"];
    keys.push("user");
    if (opts.project) keys.push(`project:${opts.project}`);
    else for (const k of this.index.keys()) if (k !== "user") keys.push(k);
    return keys.filter((k) => this.index.has(k));
  }

  _expandSynonyms(tokens) {
    if (!this.cfg.synonyms || !this.syn.size) return tokens;
    const out = new Set(tokens);
    for (const t of tokens) for (const alt of this.syn.get(t) ?? []) out.add(alt);
    return [...out];
  }

  // -- A0 keyword grep lower bound
  _grepSearch(query, opts) {
    const qTokens = [...new Set(tokenize(query))];
    const hits = [];
    for (const rec of this.records.values()) {
      if (!this._visible(rec, opts)) continue;
      const hay = `${rec.title}\n${rec.description}\n${rec.content.slice(0, 8192)}`.normalize("NFKC").toLowerCase();
      let score = 0;
      for (const t of qTokens) if (hay.includes(t)) score++;
      if (score > 0) hits.push({ id: rec.id, score });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return hits;
  }

  // -- BM25F lexical scores per candidate
  _lexScores(query, opts) {
    const qTokens = this._expandSynonyms([...new Set(tokenize(query))]);
    const t0 = performance.now();
    const raw = new Map(); // id -> bm25f
    const { k1, b } = this.cfg;
    for (const shardKey of this._shardsFor(opts)) {
      const shard = this.index.get(shardKey);
      if (!shard) continue;
      const N = shard.N;
      const avgLen = shard.avgLen || 1;
      for (const t of qTokens) {
        const post = shard.postings.get(t);
        if (!post) continue;
        const df = shard.df.get(t) ?? post.size;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        for (const [id, wtf] of post) {
          const rec = this.records.get(id);
          if (!rec || !this._visible(rec, opts)) continue;
          const len = shard.docs.get(id)?.len ?? 0;
          const s = (idf * wtf * (k1 + 1)) / (wtf + k1 * (1 - b + (b * len) / avgLen));
          raw.set(id, (raw.get(id) ?? 0) + s);
        }
      }
    }
    return { raw, elapsed: performance.now() - t0 };
  }

  _signalScore(rec, lexNorm, link) {
    const now = this.now;
    const cfg = this.cfg;
    const w = cfg.weights;
    if (this.mode === "bm25" || this.mode === "bm25f") {
      return lexNorm;
    }
    const imp = rec.importance / 10;
    const conf = rec.confidence;
    const last = Math.max(rec.lastUsed ?? 0, rec.updated ?? rec.created ?? 0);
    const hours = Math.max(0, (now - last) / 3_600_000);
    const recency = Math.pow(cfg.decayPerHour, hours);
    const use = Math.min(1, Math.log1p(rec.usedCount ?? 0) / Math.log1p(20));
    const pin = rec.pinned ? 1 : 0;
    const ttl = (cfg.ttlDays[rec.type] ?? 180) * DAY;
    const stale = now - (rec.updated ?? rec.created) > ttl ? 1 : 0;
    let s = w.lex * lexNorm;
    s += w.imp * imp + w.conf * conf + w.rec * recency + w.use * use + w.pin * pin - w.stale * stale;
    if (this.mode === "links" || this.mode === "full") s += w.link * link;
    return s;
  }

  async search(query, opts = {}) {
    const t0 = performance.now();
    const o = {
      scope: opts.scope ?? "all",
      project: opts.project ?? null,
      limit: opts.limit ?? 8,
      includeHistory: opts.includeHistory ?? false,
      includeArchived: opts.includeArchived ?? false,
    };
    if (this.mode === "grep") {
      const hits = this._grepSearch(query, o);
      const ids = hits.slice(0, o.limit).map((h) => h.id);
      return {
        query,
        ids,
        results: ids.map((id) => ({ id, score: hits.find((h) => h.id === id)?.score ?? 0 })),
        abstained: ids.length === 0,
        elapsedMs: performance.now() - t0,
        debug: { candidateCount: hits.length, store: this.name },
      };
    }
    const { raw } = this._lexScores(query, o);
    // hard filter already applied in _lexScores; candidates = raw hits
    const lexVals = [...raw.values()];
    const lexMin = lexVals.length ? Math.min(...lexVals) : 0;
    const lexMax = lexVals.length ? Math.max(...lexVals) : 1;
    const lexNorm = new Map();
    for (const [id, v] of raw) lexNorm.set(id, lexMax === lexMin ? (v > 0 ? 1 : 0) : (v - lexMin) / (lexMax - lexMin));

    // link diffusion: seeds = top-3 by raw lex (03 §3.3)
    const linkScore = new Map();
    if (this.mode === "links" || this.mode === "full") {
      const seeds = [...raw.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 3)
        .map(([id]) => id);
      const add = (id, s) => {
        const rec = this.records.get(id);
        if (!rec || !this._visible(rec, o)) return;
        linkScore.set(id, Math.min(1, (linkScore.get(id) ?? 0) + s));
      };
      const seedEntities = new Set();
      for (const sid of seeds) for (const e of this.records.get(sid)?.entities ?? []) seedEntities.add(e);
      for (const sid of seeds) {
        const rec = this.records.get(sid);
        if (!rec) continue;
        for (const l of rec.links) add(l, 0.5);
        for (const l of rec.links) {
          const r2 = this.records.get(l);
          if (!r2) continue;
          for (const l2 of r2.links) if (l2 !== sid) add(l2, 0.25);
        }
      }
      if (seedEntities.size) {
        for (const rec of this.records.values()) {
          if (!this._visible(rec, o)) continue;
          if (linkScore.has(rec.id)) continue;
          if (rec.entities.some((e) => seedEntities.has(e))) add(rec.id, 0.1);
        }
      }
    }

    const scored = new Map();
    for (const id of new Set([...raw.keys(), ...linkScore.keys()])) {
      const rec = this.records.get(id);
      if (!rec) continue;
      scored.set(id, this._signalScore(rec, lexNorm.get(id) ?? 0, linkScore.get(id) ?? 0));
    }
    let ordered = [...scored.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

    // abstain gate (03 §3.5): top lexical confidence too low and no other signal
    const topByLex = [...raw.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const topLex = topByLex ? (lexNorm.get(topByLex) ?? 0) : 0;
    const topLink = topByLex ? (linkScore.get(topByLex) ?? 0) : 0;
    const topPinned = topByLex ? (this.records.get(topByLex)?.pinned ?? false) : false;
    if (topLex < this.cfg.abstainLex && topLink === 0 && !topPinned) {
      return {
        query,
        ids: [],
        results: [],
        abstained: true,
        elapsedMs: performance.now() - t0,
        debug: { candidateCount: raw.size, store: this.name, abstain: true },
      };
    }

    // MMR over the top-50 pool (03 §3.5)
    if (this.mode === "full" && this.cfg.mmr) {
      const pool = ordered.slice(0, 50);
      const vecs = new Map();
      for (const [id] of pool) {
        const rec = this.records.get(id);
        vecs.set(id, countTokens(`${rec.title} ${rec.description} ${rec.tags.join(" ")} ${rec.content.slice(0, 4096)}`));
      }
      const lam = this.cfg.mmrLambda;
      const picked = [];
      const remaining = pool.slice();
      while (remaining.length && picked.length < Math.max(o.limit, 16)) {
        let bestIdx = 0;
        let bestVal = -Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const [id, s] = remaining[i];
          let maxCos = 0;
          for (const p of picked) maxCos = Math.max(maxCos, cosineCounts(vecs.get(id), vecs.get(p)));
          const val = lam * s - (1 - lam) * maxCos;
          if (val > bestVal) {
            bestVal = val;
            bestIdx = i;
          }
        }
        picked.push(remaining[bestIdx][0]);
        remaining.splice(bestIdx, 1);
      }
      const scoreById = new Map(ordered);
      ordered = picked.map((id) => [id, scoreById.get(id)]);
    }

    const ids = ordered.slice(0, o.limit).map(([id]) => id);
    return {
      query,
      ids,
      results: ids.map((id) => ({ id, score: ordered.find(([x]) => x === id)?.[1] ?? 0 })),
      abstained: false,
      elapsedMs: performance.now() - t0,
      debug: { candidateCount: raw.size, store: this.name },
    };
  }

  async forget(ids) {
    for (const id of [ids].flat()) {
      const rec = this.records.get(id);
      if (rec) rec.status = "dropped";
    }
    if (this.mode !== "grep") this._buildIndex();
    return { removed: [ids].flat().length };
  }

  /** Mechanical dedup/consolidation: SimHash64 Hamming<=3 + Jaccard(char3gram)>=0.82. */
  async consolidate(_opts = {}) {
    const t0 = performance.now();
    const active = [...this.records.values()].filter((r) => r.status === "active");
    const meta = active.map((r) => {
      const text = `${r.title}\n${r.description}\n${r.content}`;
      return { rec: r, sh: simhash64(text), g3: char3grams(text), group: r.id };
    });
    const parent = new Map(meta.map((m) => [m.rec.id, m.rec.id]));
    const find = (x) => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r);
      parent.set(x, r);
      return r;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    // O(n^2) is fine for the 400-doc S10 suite; skip across type/scope/project.
    for (let i = 0; i < meta.length; i++) {
      for (let j = i + 1; j < meta.length; j++) {
        const a = meta[i];
        const b = meta[j];
        if (a.rec.type !== b.rec.type || a.rec.scope !== b.rec.scope || a.rec.project !== b.rec.project) continue;
        if (hamming64(a.sh, b.sh) > 3) continue;
        if (jaccard(a.g3, b.g3) < 0.82) continue;
        union(a.rec.id, b.rec.id);
      }
    }
    const groups = new Map();
    for (const m of meta) {
      const root = find(m.rec.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(m.rec);
    }
    const merged = [];
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      members.sort((a, b) => b.importance - a.importance || a.created - b.created);
      const into = members[0].id;
      merged.push({ into, from: members.slice(1).map((m) => m.id) });
    }
    return {
      runId: `ref-${t0.toFixed(0)}`,
      startedAt: t0,
      finishedAt: performance.now(),
      merged,
      supersededChainsCompressed: 0,
      archived: [],
      digestsWritten: [],
      skipped: 0,
      llmCalls: 0,
      dryRun: false,
    };
  }

  /** Hot-index injection (03 §5), deterministic and byte-stable. */
  async buildContext(reason = "session_start") {
    const t0 = performance.now();
    const budgetChars = Math.floor(BUDGET.injectTokens * 2.8);
    const entries = [];
    const ids = [];
    const pinnedBudget = Math.floor(budgetChars * 0.25);
    const pickTop = (pool, n) => pool.slice(0, n);
    const visible = [...this.records.values()].filter((r) => r.status === "active");
    const scored = visible
      .map((r) => {
        const lex = 1; // no query: rank by static value only
        const base = this.mode === "grep" || this.mode === "bm25" || this.mode === "bm25f" ? 0 : this._signalScore(r, lex, 0) - this.cfg.weights.lex * lex;
        return { rec: r, s: base };
      })
      .sort((a, b) => b.s - a.s || (a.rec.id < b.rec.id ? -1 : 1));
    const fmt = (rec) => {
      const pin = rec.pinned ? " 📌" : "";
      const desc = rec.description.length > 80 ? rec.description.slice(0, 80) : rec.description;
      return `- [${rec.type}] ${rec.title} — ${desc}${pin} (${rec.id})`;
    };
    let used = 0;
    const header = "## HarnMem memory (~/.harnmem, shared across harnesses)\n\nUse memory_search/memory_read for details; use memory_write to write. The content below is a snapshot, not live.\n\n### User scope\n";
    used += Math.ceil(header.length / 2.8);
    const pinned = scored.filter((x) => x.rec.pinned).slice(0, BUDGET.maxPinned);
    let pinnedUsed = 0;
    for (const { rec } of pickTop(pinned, BUDGET.maxPinned)) {
      const line = fmt(rec);
      const cost = Math.ceil(line.length / 2.8) + 1;
      if (pinnedUsed + cost > pinnedBudget) continue;
      entries.push(line);
      ids.push(rec.id);
      pinnedUsed += cost;
      used += cost;
    }
    const addScope = (scopeRecs, ratio) => {
      const cap = Math.floor(budgetChars * ratio);
      let acc = 0;
      const seenType = new Map();
      for (const { rec } of scopeRecs) {
        if (ids.includes(rec.id)) continue;
        const typeCount = seenType.get(rec.type) ?? 0;
        if (typeCount >= 3) continue;
        const line = fmt(rec);
        const cost = Math.ceil(line.length / 2.8) + 1;
        if (used + cost > budgetChars || acc + cost > cap) continue;
        entries.push(line);
        ids.push(rec.id);
        seenType.set(rec.type, typeCount + 1);
        acc += cost;
        used += cost;
        if (ids.length >= BUDGET.hotEntries) break;
      }
    };
    addScope(scored.filter((x) => x.rec.scope === "user" && !x.rec.pinned), 0.3);
    addScope(scored.filter((x) => x.rec.scope === "project" && !x.rec.pinned), 0.35);
    const text =
      header +
      entries.join("\n") +
      `\n\nSnapshot(${reason}) at ${new Date(this.now).toISOString()}. Use memory_search for latest state.`;
    return {
      text,
      reason,
      snapshotAt: this.now,
      ids,
      tokensEstimate: Math.round(text.length / 2.8),
      elapsedMs: performance.now() - t0,
    };
  }

  async stats() {
    const utf8 = (s) => Buffer.byteLength(s, "utf8");
    const digits = (n) => String(n).length;
    // Comparable "memory store" size = canonical .md file bytes (frontmatter + body),
    // i.e. what actually sits under ~/.harnmem/memories. Heap/JS-object size is not the metric.
    let bodyBytes = 0;
    let contentBytes = 0;
    const docIndex = new Map();
    for (const rec of this.records.values()) {
      docIndex.set(rec.id, docIndex.size);
      const fm = [
        "---",
        "schema: harnmem/1",
        `id: ${rec.id}`,
        `type: ${rec.type}`,
        `category: ${rec.category}`,
        `scope: ${rec.scope}`,
        `project: ${rec.project ?? ""}`,
        `title: ${rec.title}`,
        `description: ${rec.description}`,
        `tags: [${rec.tags.join(", ")}]`,
        `entities: [${rec.entities.join(", ")}]`,
        `importance: ${rec.importance}`,
        `confidence: ${rec.confidence}`,
        `pinned: ${rec.pinned}`,
        `status: ${rec.status}`,
        `created: ${new Date(rec.created).toISOString()}`,
        `updated: ${new Date(rec.updated).toISOString()}`,
        `last_used: ${rec.lastUsed ? new Date(rec.lastUsed).toISOString() : ""}`,
        `used_count: ${rec.usedCount}`,
        `valid_from: ${new Date(rec.validFrom).toISOString()}`,
        `valid_to: ${rec.validTo ? new Date(rec.validTo).toISOString() : ""}`,
        `superseded_by: ${rec.supersededBy ?? ""}`,
        `links: [${rec.links.join(", ")}]`,
        `supersedes: [${rec.supersedes.join(", ")}]`,
        `source: ${rec.source?.harness ?? "cli"}/${rec.source?.session ?? ""}/${rec.source?.turn ?? 0}`,
        "---",
        "",
      ].join("\n");
      bodyBytes += utf8(fm) + utf8(rec.content) + 1;
      contentBytes += utf8(rec.title) + utf8(rec.description) + utf8(rec.content) + utf8(rec.tags.join(" "));
    }
    // Index bytes = canonical compact on-disk encoding (like index/*.json with int doc ids):
    //   token \0 df (d,tf)* -- doc ids are integer indices, not strings.
    let indexBytes = 0;
    for (const shard of this.index.values()) {
      indexBytes += 8; // shard header
      for (const [tok, m] of shard.postings) {
        indexBytes += utf8(tok) + 1 + digits(m.size);
        for (const [id, tf] of m) {
          const d = docIndex.get(id);
          if (d === undefined) continue;
          indexBytes += digits(d) + digits(Math.round(tf * 100)) + 2;
        }
      }
    }
    return {
      store: this.name,
      records: this.records.size,
      indexBytes,
      bodyBytes,
      contentBytes,
      overhead: bodyBytes ? indexBytes / bodyBytes : 0,
      overhead_content: contentBytes ? indexBytes / contentBytes : 0,
      buildMs: this.buildMs,
      shards: this.index.size,
    };
  }
}

export function normalizeRecord(r) {
  return {
    id: r.id,
    type: r.type ?? "project",
    category: r.category ?? "decision",
    scope: r.scope ?? "project",
    project: r.project ?? null,
    title: r.title ?? "",
    description: r.description ?? "",
    content: r.content ?? "",
    tags: r.tags ?? [],
    entities: r.entities ?? [],
    importance: r.importance ?? 6,
    confidence: r.confidence ?? 0.9,
    pinned: !!r.pinned,
    status: r.status ?? "active",
    created: r.created ?? Date.now(),
    updated: r.updated ?? r.created ?? Date.now(),
    lastUsed: r.last_used ?? r.lastUsed ?? null,
    usedCount: r.used_count ?? r.usedCount ?? 0,
    validFrom: r.valid_from ?? r.validFrom ?? r.created ?? Date.now(),
    validTo: r.valid_to ?? r.validTo ?? null,
    links: r.links ?? [],
    supersedes: r.supersedes ?? [],
    supersededBy: r.superseded_by ?? r.supersededBy ?? null,
    source: r.source ?? { harness: "cli", ts: Date.now() },
    extra: r.extra ?? {},
  };
}
