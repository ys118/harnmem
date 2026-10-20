/**
 * HarnMem public API — frozen contract v1 (see docs/design/07-adapter-contract.md).
 *
 * Harness adapters (pi / dsh / claude / cli) may only depend on this file's
 * exported types and the `HarnMem` facade in `./harnmem.js`. Everything else is
 * internal and may change.
 *
 * Design rules:
 *  - zero runtime dependencies (node: builtins only)
 *  - on-disk format is the SSOT; every index file is rebuildable
 *  - the engine never writes outside `harnmem.home` except for reads
 */

export const HARNMEM_API_VERSION = 1;

/** A harness that talks to harnmem. Free-form string, well-known ids below. */
export type HarnessId = "pi" | "dsh" | "claude" | "cli" | (string & {});

/** Four canonical memory types (aligned with dsh-auto-memory / ZCode / Claude Code). */
export type MemoryType = "user" | "feedback" | "project" | "reference";

/** Fine-grained semantics; free-form short tag, used for weighting/display only. */
export type MemoryCategory =
  | "profile"
  | "preference"
  | "decision"
  | "convention"
  | "lesson"
  | "pitfall"
  | "state"
  | "external"
  | (string & {});

export type MemoryScope = "user" | "project";

/**
 * Lifecycle state. `superseded` and `archived` are still on disk and readable;
 * `dropped` means moved to `trash/` (restorable until purge).
 */
export type MemoryStatus = "active" | "superseded" | "archived" | "dropped";

/** Where a memory originally came from. */
export interface MemorySource {
  harness: HarnessId;
  session?: string;
  turn?: number;
  ts: number;
  /** Migration origin, if this record was imported from another system. */
  migratedFrom?: {
    system: string;
    path?: string;
    originalId?: string;
  };
}

/** A single memory record (SSOT object; persisted as one markdown file). */
export interface MemoryRecord {
  schema: 1;
  /** `mem_` + 26 Crockford Base32 chars (ULID-like, time-sortable). */
  id: string;
  type: MemoryType;
  category?: MemoryCategory;
  scope: MemoryScope;
  /** Project id (`slug-hash`) when scope === "project". */
  project?: string;
  /** Display name of the project at write time (for humans; not authoritative). */
  projectName?: string;
  /** ≤ 80 chars; shown in indexes. */
  title: string;
  /** ≤ 200 chars; one-line hook used by retrieval and injection. */
  description: string;
  /** Markdown body, ≤ 64 KB. */
  content: string;
  tags: string[];
  entities: string[];
  /** 0..10 */
  importance: number;
  /** 0..1 */
  confidence: number;
  pinned: boolean;
  status: MemoryStatus;
  created: number;
  updated: number;
  lastUsed?: number;
  usedCount: number;
  /** Bi-temporal: when the fact became true (defaults to created). */
  validFrom: number;
  /** Bi-temporal: when the fact stopped being true (null = still true). */
  validTo: number | null;
  /** When the fact was observed/stated (may differ from created on import). */
  observedAt?: number;
  /** Number of corroborating references. */
  evidence: number;
  source: MemorySource;
  /** Change/merge origin chain (`harness:session#turn`). */
  provenance: string[];
  links: string[];
  supersedes: string[];
  supersededBy: string | null;
  sensitive?: boolean;
  /** Free-form extra frontmatter fields preserved for forward compatibility. */
  extra?: Record<string, unknown>;
}

/** Reasons that trigger a hot-index rebuild. */
export type ContextReason =
  | "session_start"
  | "resume"
  | "compaction"
  | "day_rollover"
  | "memory_write"
  | "manual"
  | "always";

export interface ContextBlock {
  /** Byte-stable injected text. Empty string when there is nothing to inject. */
  text: string;
  reason: ContextReason;
  /** Timestamp the snapshot was built (ms). Never embed this in per-turn text. */
  snapshotAt: number;
  /** Memory ids mentioned in the index. */
  ids: string[];
  /** Rough token estimate (chars/2.8 for mixed CJK). */
  tokensEstimate: number;
}

export interface SearchOptions {
  query: string;
  /** Default 8. */
  limit?: number;
  /** Default "all" (user + current project). */
  scope?: MemoryScope | "all";
  /** Override the current project shard(s). */
  project?: string;
  /** Include archived/superseded records (default false). */
  includeArchived?: boolean;
  /** Include superseded history (default false). */
  includeHistory?: boolean;
  /** Bi-temporal: only facts valid at this instant. */
  asOf?: number | string;
  /** Restrict to records mentioning this entity. */
  entity?: string;
  /** Weight override for the lexical signal (advanced). */
  weights?: Partial<Record<"lex" | "imp" | "conf" | "rec" | "use" | "pin" | "link" | "stale", number>>;
  /** Include per-signal score breakdowns. */
  debug?: boolean;
}

export interface ScoreParts {
  lex: number;
  imp: number;
  conf: number;
  rec: number;
  use: number;
  pin: number;
  link: number;
  stale: number;
  total: number;
}

export interface SearchHit {
  id: string;
  type: MemoryType;
  category?: MemoryCategory;
  scope: MemoryScope;
  project?: string;
  title: string;
  description: string;
  /** Body excerpt (~400 chars) when requested. */
  snippet?: string;
  score: number;
  status: MemoryStatus;
  pinned: boolean;
  /** True when the record is a historical (superseded) version. */
  historical: boolean;
  updated: number;
  parts?: ScoreParts;
}

export interface SearchResult {
  query: string;
  total: number;
  results: SearchHit[];
  /** True when the engine decided not to recall anything (no confident match). */
  abstained: boolean;
  debug?: {
    candidateCount: number;
    truncated: string[];
    elapsedMs: number;
    shards: string[];
  };
}

export interface WriteInput {
  type: MemoryType;
  category?: MemoryCategory;
  scope?: MemoryScope | "auto";
  project?: string;
  title: string;
  description: string;
  content: string;
  tags?: string[];
  entities?: string[];
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  links?: string[];
  supersedes?: string[];
  evidence?: string[];
  sensitive?: boolean;
  /** Override source metadata (defaults filled by the engine from config). */
  source?: Partial<MemorySource>;
}

export type WriteAction = "NEW" | "SKIP" | "MERGE" | "SUPERSEDE" | "LINK";

export interface WriteResult {
  id: string;
  action: WriteAction;
  /** Ids of records superseded by this write. */
  superseded: string[];
  warnings: string[];
  record?: MemoryRecord;
}

export interface ReadOptions {
  /** Read the version valid at this instant (bi-temporal). */
  asOf?: number | string;
  /** Include the superseded history chain. */
  includeHistory?: boolean;
}

export interface ReadResult {
  record: MemoryRecord;
  /** Ids of records that link to this one. */
  backlinks: string[];
  /** Older versions when `includeHistory` is true. */
  history?: MemoryRecord[];
}

export interface ImportOptions {
  /** Apply the same dedupe/supersede decisions as `write` (default false). */
  dedupe?: boolean;
  /** Compute decisions but don't write anything. */
  dryRun?: boolean;
}

/**
 * Bulk-import shape: like WriteInput but with explicit identity/timestamps/
 * lifecycle fields so migrations and eval corpora can materialize exact records
 * without the interactive dedupe path.
 */
export interface ImportRecord {
  id?: string;
  type: MemoryType;
  title: string;
  description?: string;
  content?: string;
  category?: MemoryCategory;
  scope?: MemoryScope;
  project?: string;
  projectName?: string;
  tags?: string[];
  entities?: string[];
  importance?: number;
  confidence?: number;
  pinned?: boolean;
  status?: MemoryStatus;
  created?: number;
  updated?: number;
  lastUsed?: number;
  usedCount?: number;
  validFrom?: number;
  validTo?: number | null;
  observedAt?: number;
  evidence?: number;
  source?: Partial<MemorySource>;
  provenance?: string[];
  links?: string[];
  supersedes?: string[];
  supersededBy?: string | null;
  sensitive?: boolean;
  extra?: Record<string, unknown>;
}

export interface ImportResult {
  ids: string[];
  skipped: number;
  superseded: string[];
  warnings: string[];
}

export interface ForgetResult {
  id: string;
  ok: boolean;
  mode: "trash" | "hard";
}

export interface RestoreResult {
  id: string;
  ok: boolean;
}

export interface TranscriptMessage {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  ts?: number;
  /** Tool name for role=tool. */
  name?: string;
}

export interface SessionEndInput {
  sessionId?: string;
  cwd?: string;
  /** Recent conversation, oldest first. Engine truncates as needed. */
  messages: TranscriptMessage[];
  /** Free-form reason ("quit" | "session_end" | ...). */
  reason?: string;
  /** Skip extraction even if autoExtract is on. */
  skipExtract?: boolean;
}

export type ExtractStatus = "skipped" | "done" | "failed" | "no_llm";

export interface ExtractResult {
  status: ExtractStatus;
  added: string[];
  superseded: string[];
  skipped: number;
  error?: string;
  /** Why extraction was skipped (when status = skipped). */
  skipReason?: string;
}

export interface Stats {
  version: 1;
  home: string;
  project: string | null;
  shards: Array<{
    name: string;
    scope: MemoryScope;
    total: number;
    active: number;
    superseded: number;
    archived: number;
    pinned: number;
    bytes: number;
  }>;
  index: {
    seq: number;
    builtAt: number;
    stale: boolean;
    sizeBytes: number;
    overhead: number;
  };
  health: {
    overBudget: boolean;
    duplicateCandidates: number;
    orphans: number;
    lastConsolidate: number | null;
  };
  extraction: {
    pending: number;
    failed: number;
    skipReasons: Record<string, number>;
  };
}

export interface ConsolidateOptions {
  dryRun?: boolean;
  /** Only mechanical passes (no LLM). */
  mechanicalOnly?: boolean;
  maxLlmCalls?: number;
}

export interface ConsolidationReport {
  runId: string;
  startedAt: number;
  finishedAt: number;
  merged: Array<{ into: string; from: string[] }>;
  supersededChainsCompressed: number;
  archived: string[];
  digestsWritten: string[];
  skipped: number;
  llmCalls: number;
  dryRun: boolean;
}

/** LLM bridge supplied by the harness adapter. Engine never does network I/O. */
export interface LlmRequest {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  /** Abort support when the harness can cancel. */
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  promptTokens?: number;
  completionTokens?: number;
}

export type LlmFn = (req: LlmRequest) => Promise<LlmResponse>;

export interface BudgetConfig {
  /** Max tokens for injected hot index (default 1200). */
  injectTokens: number;
  /** Max tokens for search tool results (default 1200). */
  searchTokens: number;
  /** Max entries in the hot index (default 24). */
  hotEntries: number;
  /** Max pinned entries in injection (default 10). */
  maxPinned: number;
}

export interface RetrievalConfig {
  k1: number;
  b: number;
  weights: { lex: number; imp: number; conf: number; rec: number; use: number; pin: number; link: number; stale: number };
  decayPerHour: number;
  mmrLambda: number;
  abstainLex: number;
  ttlDays: { user: number; feedback: number; project: number; reference: number };
  synonyms: boolean;
  /** Field weights for BM25F (title/description/tags/entities/body). */
  fields?: Partial<{ title: number; description: number; tags: number; entities: number; body: number }>;
  /** Disable 2-hop link diffusion (ablation A4). */
  linkDiffusion: boolean;
  /** Disable MMR diversity (ablation A5). */
  mmr: boolean;
}

export interface WriteConfig {
  autoExtract: boolean;
  /** Skip auto-extraction when the model already wrote this many memories. */
  skipExtractIfModelWrote: number;
  /** Minimum real user messages for extraction. */
  minUserMessages: number;
  /** Minimum digest length in chars. */
  minDigestChars: number;
  /** Max memories per extraction run. */
  maxPerRun: number;
  /** Extraction confidence floor. */
  minConfidence: number;
  /** Per-run LLM timeout in ms (adapter also enforces its own). */
  llmTimeoutMs: number;
}

export interface GovernanceConfig {
  maxUserRecords: number;
  maxProjectRecords: number;
  maxBodyBytes: number;
  consolidateEveryWrites: number;
  trashGraceDays: number;
  archiveRetention: number;
  archiveR0: number;
}

export interface HarnMemConfig {
  /** Root directory (default `$HARNMEM_HOME` or `~/.harnmem`). */
  home?: string;
  harness: HarnessId;
  sessionId?: string;
  /** Working directory used to resolve the current project. */
  cwd: string;
  /** Explicit project id (skips project resolution). */
  project?: string;
  now?: () => number;
  llm?: LlmFn | null;
  budget?: Partial<BudgetConfig>;
  retrieval?: Partial<Omit<RetrievalConfig, "weights" | "ttlDays">> & {
    weights?: Partial<RetrievalConfig["weights"]>;
    ttlDays?: Partial<RetrievalConfig["ttlDays"]>;
  };
  write?: Partial<WriteConfig>;
  governance?: Partial<GovernanceConfig>;
  /** Disable all automatic extraction (tool writes still work). */
  readOnly?: boolean;
  /** Extra debug logging sink (optional). */
  log?: (level: "debug" | "info" | "warn" | "error", msg: string, data?: unknown) => void;
}
