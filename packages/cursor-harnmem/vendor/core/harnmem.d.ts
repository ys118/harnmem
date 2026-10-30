import type { ConsolidateOptions, ConsolidationReport, ContextBlock, ContextReason, HarnMemConfig, ExtractResult, ForgetResult, ImportOptions, ImportRecord, ImportResult, ReadOptions, ReadResult, RestoreResult, SearchOptions, SearchResult, SessionEndInput, Stats, TranscriptMessage, WriteInput, WriteResult } from "./types.js";
import { type ProjectInfo } from "./project.js";
import { Store } from "./store.js";
export interface SessionStartInput {
    sessionId?: string;
    cwd?: string;
    reason?: Extract<ContextReason, "session_start" | "resume">;
    date?: string;
}
export declare class HarnMem {
    readonly apiVersion = 1;
    readonly config: HarnMemConfig;
    readonly store: Store;
    readonly project: ProjectInfo;
    private readonly index;
    private readonly retriever;
    private readonly consolidator;
    private synonyms;
    private session;
    private constructor();
    static open(options: HarnMemConfig): Promise<HarnMem>;
    private setUsage;
    private now;
    info(): {
        apiVersion: number;
        home: string;
        project: string;
        harness: string;
        sessionId: string;
    };
    sessionStart(input?: SessionStartInput): Promise<ContextBlock>;
    /** Cached, byte-stable context; rebuild only when dirty or the day changed. */
    ensureContext(reason?: ContextReason): Promise<ContextBlock>;
    /** Adapter calls this after the model itself wrote a memory this turn. */
    noteModelWrite(): void;
    invalidateContext(): void;
    private auditInjection;
    write(input: WriteInput): Promise<WriteResult>;
    importRecords(records: ImportRecord[], opts?: ImportOptions): Promise<ImportResult>;
    forget(id: string, opts?: {
        hard?: boolean;
    }): Promise<ForgetResult>;
    restore(id: string): Promise<RestoreResult>;
    search(opts: SearchOptions): Promise<SearchResult>;
    read(id: string, opts?: ReadOptions): Promise<ReadResult | null>;
    consolidate(opts?: ConsolidateOptions): Promise<ConsolidationReport>;
    rebuildIndex(): Promise<void>;
    stats(): Promise<Stats>;
    private lastAuditTs;
    /**
     * How many messages the newest completed (`status: "done"`) extraction for
     * this session already covered; `null` when none ever completed.
     *
     * This is the durable counterpart of the in-memory `extracted` flag: a
     * restarted process (or a resume catch-up) must not call the model again for
     * a journal prefix that was already extracted, but must still process turns
     * that happened after the last extraction.
     */
    private extractedMessageCount;
    /**
     * Persisted session journal for one session id, oldest first (bounded to the
     * last 200 messages). Adapters use it to rehydrate a process-local transcript
     * after a restart: DSH resumes a session in a new process without replaying
     * earlier events, so the digest would otherwise never reach the extraction
     * gates (N2 quit path).
     */
    readSessionJournal(sessionId?: string): Promise<TranscriptMessage[]>;
    /**
     * Public extraction entry point. Every attempt — including every skip — is
     * persisted to `state/audit.jsonl` as `kind: "extract"` (ROADMAP N13), so a
     * silent no-op is impossible to miss when debugging an adapter.
     */
    sessionEnd(input: SessionEndInput): Promise<ExtractResult>;
    private sessionEndRecorded;
    /**
     * Persist one `extract` audit line per session-end attempt. Audit writes are
     * advisory: a failure here must never surface as an extraction failure.
     */
    private auditExtract;
    private existingRefs;
    close(): Promise<void>;
    private autoFlushUsage;
    private shardFor;
    private resolveProjectId;
    private loadSynonyms;
}
//# sourceMappingURL=harnmem.d.ts.map