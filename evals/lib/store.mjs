/**
 * Store adapter for the eval harness. One interface, two engines:
 *
 *   - "js"   RefStore: harness-local implementation of 03-retrieval.md (A0–A5
 *            ablation ladder; default until core's dist/ exists).
 *   - "core" @harnmem/core via packages/core/dist/index.js (the product engine).
 *
 * Interface (all async unless noted):
 *   open({home, project, now}) -> this
 *   importRecords(rows[]) -> {imported, ms}
 *   search(query, opts) -> {ids, results, abstained, elapsedMs}
 *   forget(ids[]) -> {removed}
 *   consolidate(opts) -> ConsolidationReport | null
 *   buildContext(reason) -> {text, ids, tokensEstimate, elapsedMs}
 *   stats() -> {records,indexBytes,bodyBytes,overhead,buildMs}
 *   close()
 *   capabilities -> {importRecords,forget,consolidate,buildContext,weights}
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RefStore, BUDGET, DEFAULT_RETRIEVAL } from "./refstore.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVALS = resolve(HERE, "..");
const CORE_DIST = resolve(EVALS, "..", "packages", "core", "dist", "index.js");

/** A0–A5 ablation presets: JS modes and the equivalent @harnmem/core config. */
export const ABLATIONS = {
  A0: { label: "A0 keyword grep", jsMode: "grep", core: null, jsOnly: true },
  A1: {
    label: "A1 +BM25 (single field)",
    jsMode: "bm25",
    core: {
      fields: { title: 0, description: 0, tags: 0, entities: 0, body: 1 },
      weights: { lex: 1, imp: 0, conf: 0, rec: 0, use: 0, pin: 0, link: 0, stale: 0 },
      linkDiffusion: false,
      mmr: false,
    },
  },
  A2: {
    label: "A2 +BM25F fields",
    jsMode: "bm25f",
    core: { weights: { lex: 1, imp: 0, conf: 0, rec: 0, use: 0, pin: 0, link: 0, stale: 0 }, linkDiffusion: false, mmr: false },
  },
  A2b: {
    label: "A2b synonyms OFF",
    jsMode: "bm25f",
    coreOnly: true,
    core: {
      weights: { lex: 1, imp: 0, conf: 0, rec: 0, use: 0, pin: 0, link: 0, stale: 0 },
      fields: { title: 3, description: 2, tags: 2.5, entities: 2, body: 1 },
      synonyms: false,
      linkDiffusion: false,
      mmr: false,
    },
  },
  A3: {
    label: "A3 +field signals",
    jsMode: "signals",
    core: { linkDiffusion: false, mmr: false },
  },
  A4: {
    label: "A4 +links 2-hop",
    jsMode: "links",
    core: { linkDiffusion: true, mmr: false },
  },
  A5: {
    label: "A5 +MMR +budget",
    jsMode: "full",
    core: { linkDiffusion: true, mmr: true, mmrLambda: DEFAULT_RETRIEVAL.mmrLambda },
  },
};

// ------------------------------------------------------------ core adapter
async function loadCoreModule() {
  if (!existsSync(CORE_DIST)) return null;
  try {
    const mod = await import(`file://${CORE_DIST.replaceAll("\\", "/")}`);
    return mod;
  } catch (err) {
    return { __error: err };
  }
}

function toImportRecord(r) {
  return {
    id: r.id,
    type: r.type,
    category: r.category ?? "decision",
    scope: r.scope,
    project: r.project ?? undefined,
    title: r.title,
    description: r.description,
    content: r.content ?? "",
    tags: r.tags ?? [],
    entities: r.entities ?? [],
    importance: r.importance ?? 6,
    confidence: r.confidence ?? 0.9,
    pinned: !!r.pinned,
    status: r.status ?? "active",
    created: r.created,
    updated: r.updated ?? r.created,
    validFrom: r.valid_from ?? r.validFrom ?? r.created,
    validTo: r.valid_to ?? r.validTo ?? null,
    lastUsed: r.last_used ?? r.lastUsed ?? undefined,
    usedCount: r.used_count ?? r.usedCount ?? 0,
    links: r.links ?? [],
    supersedes: r.supersedes ?? [],
    supersededBy: r.superseded_by ?? r.supersededBy ?? null,
    source: r.source ?? { harness: "cli", ts: r.created },
    extra: r.extra ?? {},
  };
}

export class HarnMemStore {
  constructor() {
    this.name = "core";
    this.capabilities = { importRecords: false, forget: false, consolidate: false, buildContext: false, write: false, weights: true };
    this.harnmem = null;
    this.mod = null;
    this.buildMs = 0;
  }

  static available() {
    return existsSync(CORE_DIST);
  }

  async open(cfg) {
    this.mod = await loadCoreModule();
    if (!this.mod) throw new Error(`@harnmem/core dist not found at ${CORE_DIST} — run: pnpm --filter @harnmem/core build`);
    if (this.mod.__error) throw new Error(`failed to import @harnmem/core: ${this.mod.__error.message}`);
    const HarnMem = this.mod.HarnMem ?? this.mod.default;
    if (!HarnMem) throw new Error(`@harnmem/core exports ${Object.keys(this.mod).join(",")} but no HarnMem facade`);
    const config = {
      harness: "cli",
      cwd: process.cwd(),
      home: cfg.home,
      now: () => cfg.now,
      llm: null,
      ...(cfg.retrieval ? { retrieval: cfg.retrieval } : {}),
      ...(cfg.config ?? {}),
    };
    if (typeof HarnMem.open === "function") this.harnmem = await HarnMem.open(config);
    else if (typeof HarnMem.create === "function") this.harnmem = await HarnMem.create(config);
    else this.harnmem = new HarnMem(config);
    const proto = Object.getPrototypeOf(this.harnmem);
    this.capabilities = {
      importRecords: typeof this.harnmem.importRecords === "function" || typeof HarnMem.importRecords === "function",
      forget: typeof this.harnmem.forget === "function",
      consolidate: typeof this.harnmem.consolidate === "function",
      buildContext: typeof this.harnmem.buildContext === "function" || typeof this.harnmem.context === "function",
      write: typeof this.harnmem.write === "function",
      weights: true,
    };
    return this;
  }

  async importRecords(rows) {
    const t0 = performance.now();
    const recs = rows.map(toImportRecord);
    if (recs.length) {
      if (typeof this.harnmem.importRecords === "function") await this.harnmem.importRecords(recs, { dedupe: false });
      else {
        const { HarnMem } = this.mod;
        if (typeof HarnMem?.importRecords === "function") await HarnMem.importRecords(recs, { home: this.harnmem.home, dedupe: false });
        else throw new Error("core build does not expose importRecords(records); run `pnpm -r build` first");
      }
    }
    this.buildMs = performance.now() - t0;
    return { imported: recs.length, ms: this.buildMs };
  }

  async search(query, opts = {}) {
    const t0 = performance.now();
    const res = await this.harnmem.search({
      query,
      limit: opts.limit ?? 8,
      scope: opts.scope ?? "all",
      project: opts.project ?? undefined,
      includeHistory: !!opts.includeHistory,
      ...(opts.asOf ? { asOf: opts.asOf } : {}),
      debug: true,
    });
    return {
      query,
      ids: (res.results ?? []).map((h) => h.id),
      results: res.results ?? [],
      abstained: !!res.abstained,
      elapsedMs: typeof res.debug?.elapsedMs === "number" ? res.debug.elapsedMs : performance.now() - t0,
      debug: res.debug,
    };
  }

  /** Write-time dedupe/consolidation semantics (S10). */
  async write(input) {
    const t0 = performance.now();
    const res = await this.harnmem.write(input);
    return {
      id: res.id,
      action: String(res.action ?? "NEW").toUpperCase(),
      superseded: res.superseded ?? [],
      record: res.record,
      elapsedMs: performance.now() - t0,
    };
  }

  async forget(ids) {
    let n = 0;
    for (const id of [ids].flat()) {
      const r = await this.harnmem.forget(id);
      if (r?.ok) n++;
    }
    return { removed: n };
  }

  async consolidate(opts = {}) {
    return this.harnmem.consolidate({ mechanicalOnly: true, dryRun: false, ...opts });
  }

  async buildContext(reason = "session_start") {
    // core API: sessionStart() primes the snapshot; ensureContext(reason) returns it cached.
    let ctx;
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      ctx = await this.harnmem.sessionStart({ reason: reason === "resume" ? "resume" : "session_start" });
    } else {
      ctx = await this.harnmem.ensureContext(reason);
    }
    return {
      text: ctx.text ?? "",
      reason: ctx.reason ?? reason,
      ids: ctx.ids ?? [],
      tokensEstimate: ctx.tokensEstimate ?? Math.round((ctx.text ?? "").length / 2.8),
      elapsedMs: 0,
    };
  }

  async stats() {
    const s = await this.harnmem.stats();
    const shards = Array.isArray(s.shards) ? s.shards : [];
    const bodyBytes = shards.reduce((a, x) => a + (x.bytes ?? 0), 0);
    const indexBytes = s.index?.sizeBytes ?? 0;
    return {
      store: this.name,
      records: shards.reduce((a, x) => a + (x.total ?? 0), 0),
      indexBytes,
      bodyBytes,
      overhead: s.index?.overhead ?? (bodyBytes ? indexBytes / bodyBytes : 0),
      buildMs: this.buildMs,
      shards: shards.length,
    };
  }

  async close() {
    await this.harnmem?.close?.();
  }
}

/** Open a store for an engine/ablation combo. */
export async function openStore({ engine = "auto", ablation = "A5", home, project, now, config = {} }) {
  let chosen = engine;
  if (engine === "auto") chosen = HarnMemStore.available() ? "core" : "js";
  const ab = ABLATIONS[ablation] ?? ABLATIONS.A5;
  if (chosen === "js") {
    const store = new RefStore({ mode: ab.jsMode, config: { ...DEFAULT_RETRIEVAL, ...config } });
    await store.open({ home, project, now });
    return store;
  }
  const store = new HarnMemStore();
  // Core ablation presets are RetrievalConfig overrides (fields/weights/linkDiffusion/mmr),
  // which HarnMem expects nested under `retrieval`.
  const coreCfg = { retrieval: { ...(ab.core ?? {}), ...config } };
  await store.open({ home, project, now, config: coreCfg });
  return store;
}

export { BUDGET };
