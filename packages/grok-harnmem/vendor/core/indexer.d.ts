/**
 * In-memory BM25F index over the markdown shards, persisted as rebuildable
 * JSON. The index is a cache: memory files are the SSOT and `doctor --rebuild`
 * can always regenerate it.
 */
import type { HarnMemConfig, MemoryRecord } from "./types.js";
import { type Bm25Params } from "./text.js";
import type { ShardRef, Store } from "./store.js";
export interface DocMeta {
    id: string;
    shard: string;
    scope: string;
    project?: string;
    title: string;
    description: string;
    type: string;
    tags: string[];
    entities: string[];
    status: string;
    importance: number;
    confidence: number;
    pinned: boolean;
    created: number;
    updated: number;
    lastUsed: number;
    usedCount: number;
    validFrom: number;
    validTo: number | null;
    links: string[];
    sourceTrust: number;
    contentHash: string;
    ttlDays: number;
}
export interface ShardIndexJson {
    version: 1;
    name: string;
    seq: number;
    builtAt: number;
    docs: DocMeta[];
    docLens: number[];
    avgLen: number;
    docTerms: string[][];
    postings: Record<string, [number, number][]>;
}
export declare class ShardIndex {
    readonly name: string;
    readonly seq: number;
    readonly docs: DocMeta[];
    readonly docLens: number[];
    readonly avgLen: number;
    readonly docTerms: string[][];
    readonly postings: Map<string, Map<number, number>>;
    constructor(name: string, seq: number, docs: DocMeta[], docLens: number[], avgLen: number, docTerms: string[][], postings: Map<string, Map<number, number>>);
    get byId(): Map<string, number>;
    private _byId;
    /**
     * Adjacency maps built once per index: outgoing links (`id -> targets`) and
     * incoming links (`target -> sources`). Link diffusion on dense corpora used
     * to scan every doc per lookup (O(N^2) per query); these maps make each
     * neighbor lookup O(degree). Built lazily because most queries never touch
     * links; invalidated naturally by constructing a new ShardIndex.
     */
    private adjacency;
    private _adjacency;
    /** Outgoing links from `id` (deduped, link order). */
    outLinks(id: string): string[];
    /** Incoming links to `id` (docs that link to it, doc order). */
    inLinks(id: string): string[];
    static build(name: string, records: MemoryRecord[], seq: number, config: HarnMemConfig, shard: ShardRef): ShardIndex;
    static fromJson(json: ShardIndexJson): ShardIndex;
    toJson(builtAt: number): ShardIndexJson;
    /** Number of documents containing a term. */
    df(term: string): number;
    idfOf(term: string): number;
    /** Raw BM25F score for one doc. */
    score(queryTerms: string[], docIdx: number, params?: Bm25Params): number;
    /** Ids linked from or to `id` (1-hop, both directions), O(degree). */
    linkNeighbors(id: string): string[];
    /** Docs that link to `id` (sorted for deterministic output). */
    backlinks(id: string): string[];
}
/** Source trust by harness: user speech 1.0, tools 0.8, model inference 0.5. */
export declare function trustOf(harness: string | undefined): number;
export declare class IndexManager {
    private readonly store;
    private config;
    private cache;
    private usage;
    constructor(store: Store, config: HarnMemConfig);
    setConfig(config: HarnMemConfig): void;
    invalidate(): void;
    /** Usage counters are merged into doc metadata before ranking (no index rebuild). */
    setUsage(usage: Map<string, {
        lastUsed: number;
        usedCount: number;
    }>): void;
    private applyUsage;
    /** Cached accessor by shard name, with on-disk cache validation via per-shard seq. */
    get(shard: ShardRef): Promise<ShardIndex>;
    /** Force rebuild of a shard (writes new index + manifest entry). */
    rebuild(shard: ShardRef): Promise<ShardIndex>;
    rebuildAll(): Promise<ShardIndex[]>;
    private saveManifest;
    get size(): number;
}
export declare function shardKeyOf(shard: ShardRef): string;
//# sourceMappingURL=indexer.d.ts.map