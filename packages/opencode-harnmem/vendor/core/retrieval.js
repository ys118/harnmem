import { budgetOf, retrievalOf } from "./config.js";
import { expandQueryTerms, extractSnippet, parseTimeExpression, tokenize } from "./text.js";
import { isStale } from "./lifecycle.js";
import { clamp, estimateTokens, jaccard, sortedUnique } from "./util.js";
const HOUR = 3600000;
/**
 * Synonym-expanded query terms are weaker evidence than the user's own words.
 * They still count for candidate discovery and for an expansion-only match
 * (otherwise a "go live" -> "deploy" query would abstain), but at 35% so an exact
 * rare-token hit (S9 longtail) is never outranked by a synonym strong distractor.
 */
const EXPANSION_EVIDENCE_WEIGHT = 0.35;
export class Retriever {
    deps;
    pendingUsage = new Map();
    constructor(deps) {
        this.deps = deps;
    }
    setConfig(config) {
        this.deps.config = config;
    }
    now() {
        return (this.deps.config.now ?? Date.now)();
    }
    pendingUsageUpdates() {
        return this.pendingUsage;
    }
    resetUsage() {
        this.pendingUsage = new Map();
    }
    shards(opts = {}) {
        const scope = opts.scope ?? "all";
        const project = opts.project ?? this.deps.getProjectId();
        const out = [];
        if (scope === "all" || scope === "user")
            out.push({ scope: "user", name: "user" });
        if ((scope === "all" || scope === "project") && project)
            out.push({ scope: "project", project, name: project });
        return out;
    }
    queryTerms(query) {
        const config = retrievalOf(this.deps.config);
        const base = sortedUnique(tokenize(query, { stopwords: true, query: true }));
        if (!config.synonyms)
            return base;
        let synonyms = new Map();
        try {
            synonyms = this.deps.loadSynonyms();
        }
        catch {
            synonyms = new Map();
        }
        return sortedUnique(expandQueryTerms(base, synonyms));
    }
    /** Original (non-synonym-expanded) query terms; used for ranking strength. */
    baseQueryTerms(query) {
        return sortedUnique(tokenize(query, { stopwords: true, query: true }));
    }
    /**
     * Eligibility filter shared by lexical scoring and link diffusion. Kept out
     * of the per-shard scorer so link-boosted docs get the same status/as-of/
     * entity/time-window treatment as lexically matched ones.
     */
    isEligible(doc, opts) {
        if (doc.status === "dropped")
            return false;
        const allowedStatus = opts.includeArchived
            ? doc.status !== "dropped"
            : opts.includeSuperseded || opts.asOf !== undefined
                ? doc.status === "active" || doc.status === "superseded"
                : doc.status === "active";
        if (!allowedStatus)
            return false;
        if (opts.asOf !== undefined) {
            if (doc.validFrom > opts.asOf)
                return false;
            if (doc.validTo !== null && doc.validTo > opts.asOf)
                return false;
        }
        if (opts.entity && !doc.entities.some((e) => e.toLowerCase().includes(opts.entity)))
            return false;
        if (opts.timeWindow) {
            const anchor = doc.lastUsed || doc.updated || doc.created;
            if (anchor < opts.timeWindow.from || anchor > opts.timeWindow.to)
                return false;
        }
        return true;
    }
    /**
     * Final score for one candidate. `lex` combines relative BM25 strength with
     * BM25 saturation: raw/(raw+2) alone loses the exact-rare-token advantage
     * (S9: gold raw 37.9 -> .950 vs distractor .919); minmax/maxRaw separates the
     * best match (gold ~.95 vs distractor ~.31) while absolute weak matches stay
     * low. ScoreParts.lex remains 0..1.
     */
    buildCandidate(index, docIdx, raw, maxRaw, link, weights) {
        const config = this.deps.config;
        const retrieval = retrievalOf(config);
        const now = this.now();
        const doc = index.docs[docIdx];
        const anchor = doc.lastUsed || doc.updated || doc.created;
        const hours = Math.max(0, (now - anchor) / HOUR);
        const lex = raw > 0 && maxRaw > 0 ? (raw / maxRaw) * (raw / (raw + 2)) : 0;
        // `raw` here is *effective* lexical evidence: base-term BM25 plus a discounted
        // share of synonym-expanded matches (see EXPANSION_EVIDENCE_WEIGHT). This keeps
        // the exact-rare-token ranking of S9 while leaving expansion-only hits above the
        // abstain threshold.
        const parts = {
            lex,
            imp: clamp(doc.importance / 10, 0, 1),
            conf: clamp(doc.confidence, 0, 1),
            rec: Math.pow(retrieval.decayPerHour, hours),
            use: clamp(Math.log1p(doc.usedCount) / Math.log1p(20), 0, 1),
            pin: doc.pinned ? 1 : 0,
            link: clamp(link, 0, 1),
            stale: isStale(fakeRecord(doc), now, config) ? 1 : 0,
            total: 0,
        };
        const score = weights.lex * parts.lex +
            weights.imp * parts.imp +
            weights.conf * parts.conf +
            weights.rec * parts.rec +
            weights.use * parts.use +
            weights.pin * parts.pin +
            weights.link * parts.link -
            weights.stale * parts.stale;
        parts.total = Number(score.toFixed(6));
        return { doc, score, parts, index, docIdx };
    }
    async search(opts) {
        const started = Date.now();
        const config = this.deps.config;
        const retrieval = retrievalOf(config);
        const now = this.now();
        const query = (opts.query ?? "").trim();
        const limit = clamp(opts.limit ?? 8, 1, 50);
        const asOf = opts.asOf === undefined
            ? undefined
            : typeof opts.asOf === "number"
                ? opts.asOf
                : parseAsOfSafe(opts.asOf, now);
        const timeWindow = parseTimeExpression(query, now);
        const terms = this.queryTerms(query);
        const baseTerms = this.baseQueryTerms(query);
        const weights = { ...retrieval.weights, ...(opts.weights ?? {}) };
        const shards = opts.includeArchived ? await this.deps.store.listShards() : this.shards(opts);
        const indexes = [];
        for (const shard of shards)
            indexes.push(await this.deps.index.get(shard));
        const eligible = {
            asOf,
            includeSuperseded: Boolean(opts.includeHistory || opts.asOf),
            includeArchived: Boolean(opts.includeArchived),
            timeWindow,
            entity: opts.entity,
        };
        const bm25 = { k1: retrieval.k1, b: retrieval.b };
        // Pass 1: lexical scan across every loaded shard. Candidate discovery uses
        // all query terms (including synonym expansions), but every candidate also
        // carries a base-term score: synonym-only matches should not outrank an
        // exact rare-token hit. Build the cross-shard id -> location map once so
        // link hops can jump from a project doc to a user doc in O(1).
        const where = new Map();
        const lexical = new Map();
        let maxRaw = 0;
        for (const index of indexes) {
            index.docs.forEach((doc, docIdx) => {
                if (!this.isEligible(doc, eligible))
                    return;
                if (!where.has(doc.id))
                    where.set(doc.id, { index, docIdx });
                if (terms.length === 0)
                    return;
                const raw = index.score(terms, docIdx, bm25);
                if (raw <= 0)
                    return;
                const rawBase = baseTerms.length === terms.length ? raw : index.score(baseTerms, docIdx, bm25);
                const evidence = rawBase + EXPANSION_EVIDENCE_WEIGHT * Math.max(0, raw - rawBase);
                lexical.set(doc.id, { index, docIdx, doc, raw, evidence });
                if (evidence > maxRaw)
                    maxRaw = evidence;
            });
        }
        // Pass 2: two-hop link diffusion from the strongest raw hits (top-5 across
        // all shards). A direct neighbor gets full hop-1 evidence and a 2-hop target
        // gets half; targets may live in any loaded shard. Adjacency maps keep each
        // hop O(degree). Full hop-1 weight is what lets a user-scope reference
        // record (linked from a project decision) enter the top-10 next to its
        // anchor in S5-style "the two belong together" questions.
        const linkBoost = new Map();
        if (terms.length > 0 && retrieval.linkDiffusion && lexical.size > 0) {
            const seeds = [...lexical.values()]
                .sort((a, b) => b.evidence - a.evidence || a.doc.id.localeCompare(b.doc.id))
                .slice(0, 5);
            const seedIds = new Set(seeds.map((seed) => seed.doc.id));
            const hop1 = new Map();
            const hop2 = new Map();
            for (const seed of seeds) {
                for (const neighbor of seed.index.linkNeighbors(seed.doc.id)) {
                    if (seedIds.has(neighbor))
                        continue;
                    if (!hop1.has(neighbor))
                        hop1.set(neighbor, 1.0);
                    const location = where.get(neighbor);
                    if (!location)
                        continue;
                    for (const second of location.index.linkNeighbors(neighbor)) {
                        if (seedIds.has(second) || hop1.has(second))
                            continue;
                        if (!hop2.has(second))
                            hop2.set(second, 0.5);
                    }
                }
            }
            for (const [id, boost] of hop1)
                linkBoost.set(id, Math.max(linkBoost.get(id) ?? 0, boost));
            for (const [id, boost] of hop2)
                linkBoost.set(id, Math.max(linkBoost.get(id) ?? 0, boost));
        }
        // Pass 3: score lexical candidates plus link-only candidates.
        const candidates = [];
        const added = new Set();
        for (const entry of lexical.values()) {
            candidates.push(this.buildCandidate(entry.index, entry.docIdx, entry.evidence, maxRaw, linkBoost.get(entry.doc.id) ?? 0, weights));
            added.add(entry.doc.id);
        }
        for (const [id, boost] of linkBoost) {
            if (added.has(id))
                continue;
            const location = where.get(id);
            if (!location)
                continue;
            candidates.push(this.buildCandidate(location.index, location.docIdx, 0, maxRaw, boost, weights));
            added.add(id);
        }
        candidates.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));
        // Cap the MMR pool: diversification is O(pool * picked * jaccard), and S9
        // produced ~2500 candidates (~170ms/query). Keep the strongest
        // max(limit*10, 80); the sort above makes the cut deterministic.
        const poolCap = Math.max(limit * 10, 80);
        const pool = candidates.slice(0, poolCap);
        const diversified = retrieval.mmr ? this.mmr(pool, limit, retrieval.mmrLambda) : pool.slice(0, limit);
        const budget = budgetOf(config).searchTokens;
        const picked = [];
        let tokens = 0;
        for (const candidate of diversified) {
            const cost = this.renderHitCost(candidate);
            if (picked.length > 0 && tokens + cost > budget)
                break;
            picked.push(candidate);
            tokens += cost;
        }
        const abstained = this.shouldAbstain(terms, picked, query);
        if (abstained) {
            return {
                query,
                total: 0,
                results: [],
                abstained: true,
                debug: opts.debug
                    ? { candidateCount: candidates.length, truncated: [], elapsedMs: Date.now() - started, shards: shards.map((s) => s.name) }
                    : undefined,
            };
        }
        const results = [];
        for (const candidate of picked) {
            const shard = {
                scope: candidate.doc.scope,
                project: candidate.doc.project,
                name: candidate.doc.shard,
            };
            const record = await this.deps.store.readRecord(shard, candidate.doc.id);
            const snippet = record ? extractSnippet(record.content, 400) : candidate.doc.description;
            results.push({
                id: candidate.doc.id,
                type: candidate.doc.type,
                category: candidate.doc.category,
                scope: candidate.doc.scope,
                project: candidate.doc.project,
                title: candidate.doc.title,
                description: candidate.doc.description,
                snippet,
                score: Number(candidate.score.toFixed(4)),
                status: candidate.doc.status,
                pinned: candidate.doc.pinned,
                historical: candidate.doc.status !== "active",
                updated: candidate.doc.updated,
                parts: opts.debug ? candidate.parts : undefined,
            });
            this.noteUsage(candidate.doc.id, candidate.doc.usedCount, now);
        }
        return {
            query,
            total: candidates.length,
            results,
            abstained: false,
            debug: opts.debug
                ? { candidateCount: candidates.length, truncated: [], elapsedMs: Date.now() - started, shards: shards.map((s) => s.name) }
                : undefined,
        };
    }
    shouldAbstain(terms, picked, query) {
        if (!query)
            return false;
        if (terms.length === 0)
            return true;
        const top = picked[0];
        if (!top)
            return true;
        if (top.doc.pinned || top.parts.pin > 0)
            return false;
        const threshold = retrievalOf(this.deps.config).abstainLex;
        return top.parts.lex < threshold && top.parts.link === 0;
    }
    mmr(candidates, limit, lambda) {
        const chosen = [];
        const pool = [...candidates];
        // docTerms are long arrays (dozens of CJK n-grams); jaccard() would allocate
        // two Sets per comparison — O(pool * picked) allocations per query. Materialize
        // each candidate's set once and reuse it for every comparison.
        const termSets = new Map();
        const setOf = (candidate) => {
            let set = termSets.get(candidate);
            if (!set) {
                set = new Set(candidate.index.docTerms[candidate.docIdx] ?? []);
                termSets.set(candidate, set);
            }
            return set;
        };
        while (pool.length > 0 && chosen.length < limit) {
            let bestIdx = 0;
            let bestValue = Number.NEGATIVE_INFINITY;
            for (let i = 0; i < pool.length; i++) {
                const candidate = pool[i];
                let maxSim = 0;
                for (const picked of chosen) {
                    const sim = jaccard(setOf(candidate), setOf(picked));
                    if (sim > maxSim)
                        maxSim = sim;
                }
                const value = lambda * candidate.score - (1 - lambda) * maxSim;
                if (value > bestValue) {
                    bestValue = value;
                    bestIdx = i;
                }
            }
            chosen.push(pool.splice(bestIdx, 1)[0]);
        }
        return chosen;
    }
    renderHitCost(candidate) {
        const line = `- [${candidate.doc.type}] ${candidate.doc.title} — ${candidate.doc.description}`;
        return estimateTokens(line) + 20;
    }
    noteUsage(id, usedCount, now) {
        this.pendingUsage.set(id, { lastUsed: now, usedCount: usedCount + 1 });
    }
    /** Read one memory (optionally as-of a historical time). */
    async read(id, opts = {}) {
        const shard = await this.findShardFor(id);
        if (!shard)
            return null;
        let record = await this.deps.store.readRecord(shard, id);
        if (!record)
            return null;
        const index = await this.deps.index.get(shard);
        const result = { record, backlinks: index.backlinks(id) };
        if (opts.includeHistory) {
            const chain = [];
            let cursor = record;
            const seen = new Set();
            while (cursor && !seen.has(cursor.id)) {
                seen.add(cursor.id);
                chain.push(cursor);
                if (!cursor.supersededBy)
                    break;
                const next = await this.deps.store.findRecord(cursor.supersededBy);
                cursor = next ? next.record : null;
            }
            result.history = chain;
        }
        if (opts.asOf !== undefined) {
            const asOf = typeof opts.asOf === "number" ? opts.asOf : parseAsOfSafe(opts.asOf, this.now());
            let bestVersion = null;
            for (const scanShard of await this.deps.store.listShards()) {
                const { records } = await this.deps.store.readShard(scanShard);
                for (const candidate of records) {
                    const related = candidate.id === id || candidate.supersededBy === id || record.supersedes.includes(candidate.id);
                    if (!related)
                        continue;
                    if (candidate.validFrom > asOf)
                        continue;
                    if (candidate.validTo !== null && candidate.validTo <= asOf)
                        continue;
                    if (!bestVersion || candidate.validFrom > bestVersion.validFrom)
                        bestVersion = candidate;
                }
            }
            if (bestVersion)
                result.record = bestVersion;
            else
                result.record = { ...record, status: "archived" };
        }
        return result;
    }
    async findShardFor(id) {
        const project = this.deps.getProjectId();
        const ordered = project
            ? [{ scope: "project", project, name: project }, { scope: "user", name: "user" }]
            : [{ scope: "user", name: "user" }];
        for (const shard of ordered) {
            if (await this.deps.store.readRecord(shard, id))
                return shard;
        }
        for (const shard of await this.deps.store.listShards()) {
            if (await this.deps.store.readRecord(shard, id))
                return shard;
        }
        return null;
    }
    /**
     * Build the injected markdown block. Deterministic given (store, config,
     * project, now-second): the adapter caches it to keep the prompt prefix
     * byte-stable between turns.
     */
    async buildContext(reason = "session_start") {
        const config = this.deps.config;
        const now = this.now();
        const budgetConfig = budgetOf(config);
        const shards = this.shards();
        const indexes = [];
        for (const shard of shards)
            indexes.push(await this.deps.index.get(shard));
        const docs = indexes.flatMap((index) => index.docs);
        const digests = [];
        for (const shard of shards) {
            for (const digest of await this.deps.store.listDigests(shard)) {
                digests.push({ title: digest.title, body: digest.body });
            }
        }
        const layout = layoutHotContext(docs, digests, {
            now,
            budgetTokens: budgetConfig.injectTokens,
            maxPinned: budgetConfig.maxPinned,
            hotEntries: budgetConfig.hotEntries,
            decayPerHour: retrievalOf(config).decayPerHour,
        });
        if (!layout.hasContent) {
            return { text: "", reason, snapshotAt: now, ids: [], tokensEstimate: 0 };
        }
        const text = renderContextText(layout.sections);
        return { text, reason, snapshotAt: now, ids: layout.ids, tokensEstimate: estimateTokens(text) };
    }
}
export const CONTEXT_HEADER = "## HarnMem memory (cross-harness; stable snapshot)";
export const CONTEXT_FOOTER = "<!-- SSOT: ~/.harnmem. Use memory_search for details; never invent memory ids. Snapshot refreshes on session start, after memory writes and at day rollover. -->";
/**
 * Deterministic hot-index layout shared by the async engine path and the
 * synchronous cold-start fallback (see `hot-context.ts`). Pure function: given
 * the same docs/digests/options it renders identical bytes, which keeps the
 * injected block byte-stable across harness restarts.
 */
export function layoutHotContext(docs, digests, options) {
    const { now, budgetTokens, maxPinned, hotEntries, decayPerHour } = options;
    const active = docs.filter((doc) => doc.status === "active");
    const ids = [];
    const lines = [];
    let tokens = 0;
    const contextScore = (doc) => {
        const anchor = doc.lastUsed || doc.updated || doc.created;
        const rec = Math.pow(decayPerHour, Math.max(0, (now - anchor) / HOUR));
        const use = clamp(Math.log1p(doc.usedCount) / Math.log1p(20), 0, 1);
        return 0.55 * (doc.importance / 10) + 0.2 * doc.confidence + 0.1 * rec + 0.1 * use + 0.05 * (doc.pinned ? 1 : 0);
    };
    const pinned = active
        .filter((doc) => doc.pinned)
        .sort((a, b) => b.importance - a.importance || b.updated - a.updated || a.id.localeCompare(b.id))
        .slice(0, maxPinned);
    const pinnedIds = new Set(pinned.map((doc) => doc.id));
    for (const doc of pinned) {
        const line = `- 📌 [${doc.type}] ${doc.title} — ${doc.description}`;
        tokens += estimateTokens(line);
        ids.push(doc.id);
        lines.push(line);
    }
    const pool = active
        .filter((doc) => !pinnedIds.has(doc.id))
        .sort((a, b) => contextScore(b) - contextScore(a) || b.updated - a.updated || a.id.localeCompare(b.id));
    let added = 0;
    for (const doc of pool) {
        if (added >= Math.max(0, hotEntries - pinned.length))
            break;
        const line = `- [${doc.type}] ${doc.title} — ${doc.description}`;
        const cost = estimateTokens(line);
        if (tokens + cost > budgetTokens)
            break;
        lines.push(line);
        ids.push(doc.id);
        tokens += cost;
        added++;
    }
    const digestLines = [];
    for (const digest of digests) {
        const line = `- ${digest.title}: ${extractSnippet(digest.body, 160)}`;
        const cost = estimateTokens(line);
        if (tokens + cost > budgetTokens)
            break;
        digestLines.push(line);
        tokens += cost;
    }
    const sections = [];
    if (lines.length > 0)
        sections.push(...lines);
    if (digestLines.length > 0)
        sections.push("### Digests", ...digestLines);
    return { sections, ids, tokensEstimate: tokens, hasContent: sections.length > 0 };
}
/** Render the exact injected block around a hot-index layout. */
export function renderContextText(sections) {
    return `${CONTEXT_HEADER}\n\n${sections.join("\n")}\n\n${CONTEXT_FOOTER}`;
}
function parseAsOfSafe(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            const ts = Date.parse(`${trimmed}T23:59:59.999Z`);
            if (Number.isFinite(ts))
                return ts;
        }
        const ts = Date.parse(trimmed);
        if (Number.isFinite(ts))
            return ts;
    }
    return fallback;
}
function fakeRecord(doc) {
    return {
        schema: 1,
        id: doc.id,
        type: doc.type,
        scope: doc.scope,
        project: doc.project,
        title: doc.title,
        description: doc.description,
        content: "",
        tags: doc.tags,
        entities: doc.entities,
        importance: doc.importance,
        confidence: doc.confidence,
        pinned: doc.pinned,
        status: doc.status,
        created: doc.created,
        updated: doc.updated,
        lastUsed: doc.lastUsed || undefined,
        usedCount: doc.usedCount,
        validFrom: doc.validFrom,
        validTo: doc.validTo,
        observedAt: doc.created,
        evidence: 1,
        source: { harness: "unknown", ts: doc.created },
        provenance: [],
        links: doc.links,
        supersedes: [],
        supersededBy: null,
    };
}
//# sourceMappingURL=retrieval.js.map