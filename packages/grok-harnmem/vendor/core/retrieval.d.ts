/**
 * Retrieval: BM25F query search + deterministic hot-index assembly for context
 * injection. No embeddings, no network. See docs/design/03-retrieval.md.
 */
import type { ContextBlock, ContextReason, HarnMemConfig, ReadOptions, ReadResult, ScoreParts, SearchOptions, SearchResult } from "./types.js";
import type { Store } from "./store.js";
import type { DocMeta, IndexManager, ShardIndex } from "./indexer.js";
export interface RetrievalDeps {
    store: Store;
    index: IndexManager;
    config: HarnMemConfig;
    getProjectId: () => string | undefined;
    loadSynonyms: () => Map<string, string[]>;
}
export interface RankedCandidate {
    doc: DocMeta;
    score: number;
    parts: ScoreParts;
    index: ShardIndex;
    docIdx: number;
}
export declare class Retriever {
    private readonly deps;
    private pendingUsage;
    constructor(deps: RetrievalDeps);
    setConfig(config: HarnMemConfig): void;
    now(): number;
    pendingUsageUpdates(): Map<string, {
        lastUsed: number;
        usedCount: number;
    }>;
    resetUsage(): void;
    private shards;
    private queryTerms;
    /** Original (non-synonym-expanded) query terms; used for ranking strength. */
    private baseQueryTerms;
    /**
     * Eligibility filter shared by lexical scoring and link diffusion. Kept out
     * of the per-shard scorer so link-boosted docs get the same status/as-of/
     * entity/time-window treatment as lexically matched ones.
     */
    private isEligible;
    /**
     * Final score for one candidate. `lex` combines relative BM25 strength with
     * BM25 saturation: raw/(raw+2) alone loses the exact-rare-token advantage
     * (S9: gold raw 37.9 -> .950 vs distractor .919); minmax/maxRaw separates the
     * best match (gold ~.95 vs distractor ~.31) while absolute weak matches stay
     * low. ScoreParts.lex remains 0..1.
     */
    private buildCandidate;
    search(opts: SearchOptions): Promise<SearchResult>;
    private shouldAbstain;
    private mmr;
    private renderHitCost;
    private noteUsage;
    /** Read one memory (optionally as-of a historical time). */
    read(id: string, opts?: ReadOptions): Promise<ReadResult | null>;
    private findShardFor;
    /**
     * Build the injected markdown block. Deterministic given (store, config,
     * project, now-second): the adapter caches it to keep the prompt prefix
     * byte-stable between turns.
     */
    buildContext(reason?: ContextReason): Promise<ContextBlock>;
}
export declare const CONTEXT_HEADER = "## HarnMem memory (cross-harness; stable snapshot)";
export declare const CONTEXT_FOOTER = "<!-- SSOT: ~/.harnmem. Use memory_search for details; never invent memory ids. Snapshot refreshes on session start, after memory writes and at day rollover. -->";
/** Digest page summary used by the injected hot index. */
export interface HotDigest {
    title: string;
    body: string;
}
export interface HotContextOptions {
    now: number;
    budgetTokens: number;
    maxPinned: number;
    hotEntries: number;
    decayPerHour: number;
}
export interface HotContextLayout {
    sections: string[];
    ids: string[];
    tokensEstimate: number;
    hasContent: boolean;
}
/**
 * Deterministic hot-index layout shared by the async engine path and the
 * synchronous cold-start fallback (see `hot-context.ts`). Pure function: given
 * the same docs/digests/options it renders identical bytes, which keeps the
 * injected block byte-stable across harness restarts.
 */
export declare function layoutHotContext(docs: readonly DocMeta[], digests: readonly HotDigest[], options: HotContextOptions): HotContextLayout;
/** Render the exact injected block around a hot-index layout. */
export declare function renderContextText(sections: readonly string[]): string;
//# sourceMappingURL=retrieval.d.ts.map