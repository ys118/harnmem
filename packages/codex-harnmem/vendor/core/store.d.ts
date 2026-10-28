import { dirname } from "node:path";
import type { MemoryRecord, MemoryScope, TranscriptMessage } from "./types.js";
export interface ShardRef {
    scope: MemoryScope;
    /** projectId for project scope; undefined for user scope. */
    project?: string;
    /** Directory name used in paths, e.g. "user" or the projectId. */
    name: string;
}
export interface ShardRecords {
    shard: ShardRef;
    records: MemoryRecord[];
    errors: {
        file: string;
        message: string;
    }[];
}
export interface AuditEntry {
    seq?: number;
    ts: number;
    kind: string;
    harness?: string;
    session?: string;
    [key: string]: unknown;
}
export interface DigestEntry {
    name: string;
    title: string;
    body: string;
    updated?: number;
}
export interface UsageEntry {
    lastUsed: number;
    usedCount: number;
}
export declare class Store {
    readonly home: string;
    private seqCache;
    private shardSeqCache;
    constructor(home: string);
    path(...parts: string[]): string;
    get memoriesDir(): string;
    get stateDir(): string;
    get indexPath(): string;
    get trashDir(): string;
    init(): Promise<void>;
    shardRef(scope: MemoryScope, projectId?: string): ShardRef;
    shardDir(shard: ShardRef): string;
    indexFile(shard: ShardRef): string;
    digestDir(shard: ShardRef): string;
    recordPath(shard: ShardRef, id: string): string;
    listShards(): Promise<ShardRef[]>;
    /** Read every `.md` file in a shard (excluding MEMORY.md). */
    readShard(shard: ShardRef): Promise<ShardRecords>;
    readRecord(shard: ShardRef, id: string): Promise<MemoryRecord | null>;
    /** Find a record by id across all shards (cheap scan; ids are unique). */
    findRecord(id: string): Promise<{
        record: MemoryRecord;
        shard: ShardRef;
    } | null>;
    writeRecord(shard: ShardRef, record: MemoryRecord): Promise<void>;
    /** Bulk write (import/migration): files first, index once, seq once. */
    writeRecordsBulk(shard: ShardRef, records: MemoryRecord[]): Promise<void>;
    /** Update MEMORY.md one line at a time (index is derived, safe to rebuild). */
    private upsertIndexLine;
    /** Move a record file to trash (soft delete for `forget`). */
    moveToTrash(shard: ShardRef, record: MemoryRecord, now: number): Promise<string>;
    getSeq(): Promise<number>;
    /**
     * Per-shard sequence: index validity is checked against it, so a write to one
     * project never invalidates unrelated shard indexes (global seq invalidates all).
     */
    getShardSeq(name: string): Promise<number>;
    /** Read the seq from disk, bypassing the in-process cache (cross-process freshness). */
    peekSeq(): Promise<number>;
    bumpSeq(shardName?: string): Promise<number>;
    audit(entry: Omit<AuditEntry, "seq"> & {
        seq?: number;
    }): Promise<void>;
    getCursor(key: string): Promise<string | null>;
    setCursor(key: string, value: string): Promise<void>;
    private usageCache;
    /**
     * Usage counters live in `state/usage.json`, not in the memory files: a search
     * touches up to `budget` records, and rewriting N markdown files per query
     * (plus invalidating every shard index) does not scale. Memory files stay the
     * SSOT for content; `doctor --merge-usage` folds these counters back into the
     * frontmatter when it matters.
     */
    loadUsage(): Promise<Map<string, UsageEntry>>;
    /** Persist usage counters (lastUsed/usedCount) touched by searches. */
    saveUsage(updates: Map<string, UsageEntry>): Promise<void>;
    /**
     * Session journal entry (only what extraction needs).
     *
     * Idempotent per message: re-persisting a snapshot that already covers
     * messages from an earlier process (the adapter rehydrates its digest from
     * this journal) appends only the lines that are not already present.
     */
    appendSession(input: {
        harness: string;
        sessionId: string;
        cwd: string;
        date?: string;
        messages: {
            role: string;
            text: string;
            ts?: number;
        }[];
    }): Promise<void>;
    /**
     * Read one session's persisted journal across day directories, oldest first,
     * deduplicated and bounded to the last 200 messages.
     *
     * DSH resumes a session in a new process without replaying earlier events, so
     * an adapter that only kept a process-local digest would always hit the
     * `too_few_messages` gate at the next quit. Adapters use this to rehydrate.
     */
    readSessionTranscript(harness: string, sessionId: string): Promise<TranscriptMessage[]>;
    listDigests(shard: ShardRef): Promise<DigestEntry[]>;
    /** Load/save per-shard search index JSON. */
    loadIndex(name: string): Promise<unknown | null>;
    saveIndex(name: string, value: unknown): Promise<void>;
    readManifest(): Promise<{
        version: number;
        seq: number;
        shards: unknown[];
    } | null>;
    writeManifest(seq: number, shards: unknown[]): Promise<void>;
    /** Rebuild human-readable MEMORY.md for a shard from its files. */
    rebuildIndexFile(shard: ShardRef): Promise<number>;
    stats(): Promise<{
        memories: number;
        user: number;
        projects: Record<string, number>;
        archived: number;
        superseded: number;
        trash: number;
        digests: number;
    }>;
}
export declare function shardKey(shard: ShardRef): string;
export declare function shardFromName(name: string): ShardRef;
export { dirname };
//# sourceMappingURL=store.d.ts.map