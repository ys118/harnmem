import { Store } from "./store.js";
import type { MemoryCategory, MemoryScope, MemoryStatus, MemoryType } from "./types.js";
/** Options for {@link MemoryInspector.open}. */
export interface MemoryInspectorOptions {
    /** HarnMem home; defaults to `HARNMEM_HOME` then `~/.harnmem`. */
    home?: string;
    /** Clock override for deterministic tests. */
    now?: number;
    /** Parsed-shard cache TTL in milliseconds; `0` disables caching. */
    cacheTtlMs?: number;
}
/** One diagnostics/warning row surfaced by the inspector. */
export interface InspectIssue {
    level: "warn" | "error";
    code: string;
    message: string;
}
/** A record file that failed to parse (the rest of the shard still renders). */
export interface InspectFileError {
    file: string;
    message: string;
}
/** Per-shard aggregate shown in the overview. */
export interface InspectShard {
    /** Shard name: `"user"` or the project id (`<slug>-<hash>`). */
    name: string;
    scope: MemoryScope;
    project: string | null;
    projectName: string | null;
    label: string;
    total: number;
    active: number;
    superseded: number;
    archived: number;
    pinned: number;
    bytes: number;
    tokens: number;
    indexBytes: number;
    lastUpdated: number | null;
}
/** List-row projection of one memory (no body). */
export interface InspectRow {
    id: string;
    type: MemoryType;
    category: MemoryCategory | null;
    scope: MemoryScope;
    project: string | null;
    projectName: string | null;
    title: string;
    description: string;
    preview: string;
    tags: string[];
    entities: string[];
    importance: number;
    confidence: number;
    pinned: boolean;
    status: MemoryStatus;
    created: number;
    updated: number;
    lastUsed: number | null;
    usedCount: number;
    validFrom: number;
    validTo: number | null;
    supersededBy: string | null;
    links: string[];
    supersedes: string[];
    evidence: number;
    bytes: number;
    tokens: number;
    harness: string;
}
/** Full projection of one memory, including the on-disk text. */
export interface InspectMemory extends InspectRow {
    /** Markdown body (frontmatter stripped). */
    content: string;
    /** Parsed frontmatter as stored. */
    frontmatter: Record<string, unknown>;
    /** Verbatim file contents. */
    raw: string;
    /** Path relative to the HarnMem home, POSIX separators. */
    filePath: string;
    /** Ids of records whose `links` point here (cross-shard). */
    backlinks: string[];
    /** Older versions, newest first, when `history` was requested. */
    history?: InspectRow[];
}
/** Project registry entry merged with on-disk shard facts. */
export interface InspectProject {
    id: string;
    slug: string;
    name: string;
    paths: string[];
    harnesses: string[];
    registered: boolean;
    shards: string[];
    total: number;
    pinned: number;
    lastUpdated: number | null;
}
/** Index health reported by the overview. */
export interface InspectIndexStatus {
    manifest: {
        seq: number;
        builtAt: number;
        bytes: number;
        shards: Array<{
            name: string;
            docs: number;
        }>;
    } | null;
    /** Current store sequence (`state/seq.json`). */
    seq: number;
    /** Manifest sequence is behind the store sequence. */
    stale: boolean;
    files: Array<{
        shard: string;
        path: string;
        bytes: number;
        exists: boolean;
        docs: number | null;
        records: number;
    }>;
}
/** The injected hot-index block, replayed from disk. */
export interface InspectContext {
    cwd: string | null;
    projectId: string | null;
    projectName: string | null;
    shards: string[];
    text: string;
    ids: string[];
    tokensEstimate: number;
    bytes: number;
    budgetTokens: number;
    hotEntries: number;
    atBudget: boolean;
}
/** Whole-home snapshot for the overview screen. */
export interface InspectOverview {
    version: 1;
    home: string;
    generatedAt: number;
    project: string | null;
    projectName: string | null;
    totals: {
        records: number;
        active: number;
        superseded: number;
        archived: number;
        pinned: number;
        bytes: number;
        tokens: number;
        shards: number;
        projects: number;
        trash: number;
        digests: number;
    };
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    byHarness: Record<string, number>;
    budget: {
        injectTokens: number;
        hotEntries: number;
        maxPinned: number;
    };
    context: InspectContext;
    shards: InspectShard[];
    projects: InspectProject[];
    index: InspectIndexStatus;
    issues: InspectIssue[];
    fileErrors: InspectFileError[];
}
/** Result of {@link MemoryInspector.list}. */
export interface InspectList {
    shard: string;
    label: string;
    total: number;
    rows: InspectRow[];
    generatedAt: number;
}
/** Result of {@link MemoryInspector.indexText}. */
export interface InspectIndexText {
    text: string;
    bytes: number;
    parts: Array<{
        shard: string;
        label: string;
        path: string;
        text: string;
        bytes: number;
    }>;
    generatedAt: number;
}
/** Options for {@link MemoryInspector.list}. */
export interface InspectListOptions {
    /** `"all"` (default), `"user"`, or a project shard name. */
    shard?: string;
    /** Include superseded/archived records; defaults to `true`. */
    includeInactive?: boolean;
}
/** Options for {@link MemoryInspector.overview}. */
export interface InspectOverviewOptions {
    /** Working directory used to resolve the current project shard. */
    cwd?: string;
}
/** Options for {@link MemoryInspector.context}. */
export interface InspectContextOptions {
    cwd?: string;
    /** Override the injection token budget. */
    budgetTokens?: number;
    /** Override the hot-entry count. */
    hotEntries?: number;
}
/** Options for {@link MemoryInspector.read}. */
export interface InspectReadOptions {
    id: string;
    /** Include the superseded-version chain. */
    history?: boolean;
}
/** Options for {@link MemoryInspector.indexText}. */
export interface InspectIndexOptions {
    /** `"all"` (default), `"user"`, or a project shard name. */
    shard?: string;
}
/**
 * Read-only view over one HarnMem home.
 *
 * @example
 * ```ts
 * const inspector = await MemoryInspector.open({ home });
 * const overview = await inspector.overview({ cwd });
 * const list = await inspector.list({ shard: "all" });
 * await inspector.close();
 * ```
 */
export declare class MemoryInspector {
    /** Resolved HarnMem home (absolute). */
    readonly home: string;
    /** Underlying store handle; only its read methods are used. */
    readonly store: Store;
    private readonly fixedNow;
    private readonly cacheTtlMs;
    private readonly snapshots;
    private registryCache;
    private constructor();
    /**
     * Open an inspector over `home` (resolved like the engine: explicit option,
     * then `HARNMEM_HOME`, then `~/.harnmem`). Never writes to disk.
     */
    static open(options?: MemoryInspectorOptions): Promise<MemoryInspector>;
    /** Drop cached shards and registry state. */
    close(): Promise<void>;
    private clock;
    private registry;
    private snapshot;
    private shardsFor;
    private labelOf;
    private row;
    private renderContext;
    /** All project registry rows, merged with on-disk shard totals. */
    projects(): Promise<InspectProject[]>;
    /** Whole-home snapshot used by the overview screen. */
    overview(options?: InspectOverviewOptions): Promise<InspectOverview>;
    private indexStatus;
    private countFiles;
    private countDigests;
    /** Memories in one shard (or all shards), newest-first per the panel order. */
    list(options?: InspectListOptions): Promise<InspectList>;
    /** One memory with body, frontmatter, raw text, backlinks and optional history. */
    read(options: InspectReadOptions): Promise<InspectMemory | null>;
    /** Replay the injected hot-index block for a working directory. */
    context(options?: InspectContextOptions): Promise<InspectContext>;
    /** Verbatim `MEMORY.md` shard index text (what humans and models skim). */
    indexText(options?: InspectIndexOptions): Promise<InspectIndexText>;
}
/** Convenience wrapper around {@link MemoryInspector.open}. */
export declare function openInspector(options?: MemoryInspectorOptions): Promise<MemoryInspector>;
//# sourceMappingURL=inspect.d.ts.map