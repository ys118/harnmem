# 01 · Architecture: components, technology choices, concurrency, and security

## 1. Technology choices (conclusions first)

| Choice | Decision | Rationale |
|---|---|---|
| Language | **TypeScript** (Node.js ≥ 20, running as ESM) | All three host categories run a JS runtime: pi (Node), DSH (Electron/Node), Claude Code (Node/Bun); TS types contain the complexity of this cross-harness protocol; consistent with the existing ecosystem (pi-memory's single-file TS extension) |
| Runtime dependencies | **0** (only `node:fs` / `node:path` / `node:crypto` / `node:util` / `node:zlib`) | Meets "works out of the box"; avoids npm supply-chain and version hell; most reliable under the differing Node versions of pi/DSH/Claude Code |
| Package management / build | pnpm workspace + esbuild (devDependency) | Matches the user's existing habits; esbuild bundles a single-file ESM that pi can load directly and DSH can install easily |
| SSOT format | **Markdown + YAML-subset frontmatter** (one file per memory) | Human-readable and editable, diff-friendly, git-syncable, parseable in any language; avoids SQLite binding differences across Bun/Electron/Node |
| Index | **Pure JS/TS inverted index** (BM25 + CJK bigram), persisted as JSON shards | No native modules; p95 < 50ms at 10k records; the index can be deleted and rebuilt; no lucene/flexsearch-class heavy dependencies |
| Semantic recall | **Optional**: user-configured OpenAI-compatible embedding / host-LLM reranking; off by default | Zero-dependency principle; progressive enhancement; no local embedding model |
| Migration | Ships `harnmem import` (DSH / pi / ZCode / JSON formats → unified format) | Users already hold substantial memory assets; migration must be lossless |
| Evaluation | Ships `evals/` offline scoring (TS runner) | Turns "memory quality" into a regressable metric instead of guesswork |

**Rejected**: Python (awkward to embed in hosts, slow startup), Rust/WASM (complex build chain, hard to distribute across harnesses), SQLite (native module + runtime differences), vector databases (violate zero external dependencies).

## 2. Code structure and responsibilities

```
packages/core/src/
├── index.ts            # public exports (HarnMem facade, types)
├── harnmem.ts          # session lifecycle: open/ensureContext/search/write/sessionEnd
├── store/
│   ├── paths.ts        # ~/.harnmem layout, projectId computation, path safety
│   ├── markdown.ts     # YAML-subset frontmatter parse/serialize (self-implemented)
│   ├── memory.ts       # Memory type, validation, normalization, diff/patch
│   ├── repo.ts         # read/write, atomic writes, trash, file locks, provenance
│   └── project.ts      # project identity registry (git remote / path → projectId)
├── index/
│   ├── tokenizer.ts    # English words + CJK bigrams + normalization
│   ├── bm25.ts         # scoring (field weights: title/desc/tags/body)
│   ├── inverted.ts     # inverted-table build/increment/merge
│   └── persist.ts      # sharded JSON I/O, versioning, validation, rebuild
├── recall/
│   ├── search.ts       # query → candidates → ranking → quotas → assembly
│   ├── hotindex.ts     # hot-index snapshot (injection block) generation
│   └── hybrid.ts       # optional dense + RRF fusion
├── write/
│   ├── ops.ts          # ADD/UPDATE/DELETE/NOOP operators (with conflict rules)
│   ├── dedupe.ts       # normalized hashing, SimHash, title/content similarity
│   ├── extract.ts      # session digest → candidate memories (prompt + strict JSON parsing)
│   └── apply.ts        # candidates → disk (idempotent, audited, supersedes)
├── lifecycle/
│   ├── score.ts        # composite importance/recency/usage-feedback score
│   ├── decay.ts        # decay and state transitions (active → archived → dropped; superseded is a terminal branch)
│   ├── consolidate.ts  # merge/rewrite/conflict resolution (optional LLM)
│   └── budgets.ts      # capacity budgets, eviction priority
├── session/
│   ├── digest.ts       # build digest input from transcript/turn lists
│   └── queue.ts        # extraction job queue (cross-process, retryable)
├── cli/                # command implementations reusable inside core (wrapped by packages/cli)
├── migrate/            # dsh / pi / zcode → unified schema
└── util/               # locks, glob, logger, token estimation, errors
```

`packages/cli`: the `harnmem` command (`stats`, `search`, `read`, `write`, `forget`, `restore`, `consolidate`, `rebuild`, `export`, `import`).
`packages/pi-harnmem`: the pi extension entry (single-file TS or esbuild output); it only does hook mapping, tool-schema registration, host-LLM adaptation, and TUI status output.
`packages/mcp` (`@harnmem/mcp`): MCP stdio server + Claude Code hooks bridge (design in 09); `packages/harnmem-dsh`: DSH plugin (design in 08). Both are later phases.

> Implementation status: core is not laid out per the tree above; it currently consists of 13 flat files under `packages/core/src/` (`harnmem.ts` / `store.ts` / `retrieval.ts` / `types.ts` / `frontmatter.ts` / `lifecycle.ts` / `indexer.ts` / `util.ts` / `text.ts` / `consolidate.ts` / `project.ts` / `extract.ts` / `config.ts`). This section is kept as a layering target; the source is authoritative.

## 3. Core interface (actual v1 facade)

> This section used to be a "pre-freeze draft" (`startSession`/`update`/`pin`/`dispose`, etc.). The implementation converged on the `HarnMem` class below; **the authoritative contract is `docs/design/07-adapter-contract.md` §1/§3 and `packages/core/src/types.ts`**, and this section only records the facade shape.

```ts
// Provided by the host (core never accesses the network directly)
export interface LlmFn {
  (req: { system: string; prompt: string; maxTokens?: number;
          temperature?: number; reasoningEffort?: "low"|"medium"|"high";
          signal?: AbortSignal }): Promise<{ text: string }>;
}

// core's public facade (packages/core/src/harnmem.ts; an ESM class, not an interface draft)
export class HarnMem {
  static open(options: HarnMemConfig): Promise<HarnMem>;   // load config, init store, deploy assets
  readonly apiVersion: 1;
  readonly config: HarnMemConfig;
  readonly store: Store;
  readonly project: ProjectInfo;
  info(): { apiVersion: number; home: string; project: string; harness: string; sessionId: string };

  sessionStart(input?: { sessionId?; cwd?; reason?: "session_start"|"resume"; date? }): Promise<ContextBlock>;
  ensureContext(reason?: ContextReason): Promise<ContextBlock>;   // rebuild when dirty/day changed, otherwise cached
  noteModelWrite(): void;                                // model wrote memory itself → mark dirty + suppress auto-extraction
  invalidateContext(): void;

  write(input: WriteInput): Promise<WriteResult>;         // NEW|SKIP|MERGE|SUPERSEDE|LINK
  importRecords(records: ImportRecord[], opts?: ImportOptions): Promise<ImportResult>;
  forget(id: string, opts?: { hard?: boolean }): Promise<ForgetResult>;
  restore(id: string): Promise<RestoreResult>;

  search(opts: SearchOptions): Promise<SearchResult>;     // read-only; returns hits + abstained
  read(id: string, opts?: ReadOptions): Promise<ReadResult | null>;
  consolidate(opts?: ConsolidateOptions): Promise<ConsolidationReport>;
  rebuildIndex(): Promise<void>;
  stats(): Promise<Stats>;

  sessionEnd(input: SessionEndInput): Promise<ExtractResult>;  // append journal + optional background extraction
  close(): Promise<void>;                                 // flush usage/logs
}
```

**Adapter contract (6 hooks + 5 tools)**: harness events map to facade methods — `session_start`→`open`+`sessionStart`; per-turn context→`ensureContext` (pi: append to systemPrompt in `before_agent_start`); message journaling/memory writes→`noteModelWrite`/`invalidateContext`; compaction→`ensureContext("compaction")`; shutdown→`sessionEnd`+`close`; LLM→`LlmFn` (optional; without it, writes rely on tools plus mechanical governance).

Tool set (unified across harnesses): `memory_write`, `memory_search`, `memory_read`, `memory_forget`, `memory_status` (5 tools; the earlier draft's `memory_update`/`memory_restore`/`memory_stats`/`scratchpad_write` were not implemented — updates go through `write`'s supersede/merge, and restore goes through `/memory restore` or `restore()`).

## 4. Data flows

### 4.1 Read (session start)

1. Compute `projectId` (see 02): normalize `git remote get-url --push` → `github.com/acme/example-project`; fall back to a hash of the normalized path when no remote exists.
2. Check `index/manifest.json`'s `seq` against `state/seq`; if behind → incremental rebuild (at most one full rebuild).
3. Read document metadata for both user and project scopes (title/description/type/tags/importance/updated/status).
4. Allocate quotas: all pinned → user (≤1K tokens) → project (≤2K tokens), sorted by value score descending, with type quotas (decisions/preferences first; reference material later).
5. Generate the injection block (fixed template, fixed sort keys → byte-stable for the same session/dataset, KV-cache friendly).
6. Record an audit entry: which ids were injected, byte counts, truncation details (`state/audit.jsonl`).

### 4.2 Retrieval (tool call)

`memory_search(query, {scope, type, limit})`:

1. Tokenize (English words + Chinese bigrams) → multi-field BM25 scoring;
2. Filter: status != dropped, scope match (default user + current project), optional includeArchived;
3. Weighting: `final = bm25_norm * w_lex + importance_norm * w_imp + recency * w_rec + usage * w_use`;
4. Dedupe: entries with the same `content_hash` / high SimHash are merged in the display;
5. Truncate: return ≤ N entries (default 8) with total bytes ≤ budget; each entry returns id/title/description/snippet (first 400 chars of the body);
6. Record `last_used/used_count` (recall feedback used by governance, persisted asynchronously).

`memory_read(id)` returns the full body (constrained by the per-record limit).

### 4.3 Write (tool)

1. Validate fields and normalize (title summary, description generation, tag cleanup);
2. Determine scope: explicit, or inferred from cwd (global knowledge defaults to user, project knowledge to project);
3. Similarity check: compare against existing memories in the same scope (normalized hash / SimHash / title similarity);
4. Decide: `NEW`, `SKIP (already exists)`, `SUPERSEDE (old entry replaced)`, `MERGE (suggest consolidate)`;
5. Atomic write (`tmp` → `rename`) + index update (incremental) + audit + `seq++`;
6. Return `{id, action, superseded?}`.

### 4.4 Session end / background extraction

1. Assemble the session transcript (the adapter provides a recent-N-turn digest or raw messages);
2. Skip conditions: too few user messages (< 3 substantive messages), the main model already wrote memories this session, the same digest was already extracted (idempotency hash);
3. digest → extraction prompt → host LLM → strict JSON (candidate list, each with type/scope/title/description/content/tags/importance/evidence);
4. Each candidate goes through the "write pipeline" (including update-op decisions); failures do not retry destructive operations;
5. Write `sessions/<date>/<harness>-<sessionId>.jsonl` with the raw digest + `state/cursors.json` cursor;
6. When a threshold is met (e.g. 20 cumulative extractions / 10 minutes idle / manual) → trigger `consolidate()`.

## 5. Concurrency model (multiple harnesses online at once is the norm)

**Problem**: pi, DSH, and Claude Code may run simultaneously, all possibly writing to `~/.harnmem/`.

| Scenario | Mechanism |
|---|---|
| Single-memory write | Atomic write: `write tmp` → `fsync` → `rename`; readers always see a complete file |
| Concurrent update to the same memory | Record `mtime+hash` before writing and verify after (compare-and-swap); on conflict write `conflicts/<id>-<ts>.md` and keep both sides, never silently overwrite |
| Index update | Single-writer lock `state/index.lock` (content `{pid,host,ts}` + TTL 30s + process liveness probe); critical section < 100ms; if the lock cannot be acquired, only write a dirty marker and rebuild later |
| Index read | `manifest.json` carries `seq`; readers compare against `state/seq` to decide whether to reload; in-process caches invalidate by mtime |
| Extraction jobs | Claim via atomic rename of `state/queue/<job>.json`; idempotency key = `sessionId + digestHash`; up to 3 retries with exponential backoff |
| Session logs | One file per session, naturally single-writer, append-only |
| Directory/metadata scans | `memories/**` filenames are uuids; no cross-file transactions needed; health checks (doctor) can validate everything |
| Crash recovery | Scan `*.tmp`, `trash/`, `journal/` at startup; rebuild the index if its checksum does not match |

**Not doing**: cross-process shared memory, real-time watching (unreliable and power-hungry). The rule is "compare mtime/seq on the next operation".

## 6. Security and privacy

- **Path safety**: memory ids are only `mem_` + 26 lowercase Crockford Base32 characters (self-generated); `path.resolve` + prefix validation before any write; symlinks under `memories/` are rejected outright (prevents out-of-tree reads/writes).
- **Sensitive information**: the extraction prompt explicitly requires "never record passwords/tokens/keys/ID numbers"; a regex scan runs before persistence (`sk-`, `ghp_`, `AKIA`, private-key headers, long hex); matches are redacted to `[REDACTED:kind]` and the frontmatter gets `sensitive: true`.
- **Size limits**: per-record body limit 64KB (`maxBodyBytes` default 65536); per-scope soft limits (default user 500 / project 3000); `sessions/` file limit 8MB, rotated daily.
- **Audit**: `state/audit.jsonl` records injection (id list/bytes), writes (action), merges (source ids), archives (reason), and forgets; append-only, making it easy to investigate "why does the model know/not know something".
- **User sovereignty**: pinned memories are immune to automatic governance; `harnmem forget` only moves to trash; `export --json` provides a full export.

## 7. Configuration (`~/.harnmem/config.json`, all optional)

> `packages/core/src/config.ts` is authoritative (the values below are the actual defaults). Configuration precedence: built-in defaults → `~/.harnmem/config.json` → `<projectRoot>/.harnmem.json` → explicit options passed when opening the engine; the pi adapter additionally supports `<agentDir>/harnmem.json` and `HARNMEM_*` environment overrides (higher precedence).

```jsonc
{
  "budget": { "injectTokens": 1200, "searchTokens": 1200, "hotEntries": 24, "maxPinned": 10 },
  "retrieval": {
    "k1": 1.2, "b": 0.75, "abstainLex": 0.15, "synonyms": true, "mmr": true,
    "ttlDays": { "user": 365, "feedback": 365, "project": 180, "reference": 365 }
  },
  "write": {
    "autoExtract": true, "skipExtractIfModelWrote": 1, "minUserMessages": 3,
    "minDigestChars": 500, "maxPerRun": 6, "minConfidence": 0.5, "llmTimeoutMs": 12000
  },
  "governance": {
    "maxUserRecords": 500, "maxProjectRecords": 3000, "maxBodyBytes": 65536,
    "consolidateEveryWrites": 200, "trashGraceDays": 30, "archiveRetention": 180, "archiveR0": 0.3
  }
}
```

Environment variables (read by the pi adapter; core itself does not read the environment): `HARNMEM_HOME` (override the directory), `HARNMEM_DISABLED`, `HARNMEM_READONLY`, `HARNMEM_DEBUG=1`, `HARNMEM_AUTO_EXTRACT`, `HARNMEM_INJECT`.

## 8. Failure modes and degradation

| Failure | Symptom | Handling |
|---|---|---|
| Host has no LLM capability | Extraction unavailable | Tool-driven writes only; governance degrades to mechanical rules; `memory_stats` reports it |
| Corrupted index | Retrieval errors/empty | Checksum failure → automatic full rebuild (< 2s per 10k records), with a warning |
| Lock contention | Writes slow down | Take over after TTL expiry; tiny critical sections; concurrent writes are queued |
| Disk full | Writes fail | Explicit error, never swallow exceptions; governance prompts trash cleanup |
| User manually corrupts a file | frontmatter parse failure | Lenient parsing (keep the body, repair fields); `doctor` reports it |
| Directory locked by sync software | Writes fail | Retry 3 times + prompt to check the sync client (OneDrive) |

## 9. Build and distribution

- `packages/core`: `tsc` emits `dist/*.js + *.d.ts` (ESM); `package.json` declares only `engines.node >= 20` and `dependencies: {}`.
- `packages/pi-harnmem`: `esbuild` produces a **single file** `dist/index.js` (with core inlined) that the pi extension loads directly; during development use `pi install ./packages/pi-harnmem`.
- `packages/cli`: `bin: { harnmem: "./dist/cli.js" }`, published under the `harnmem`-style name (final naming in 06).
- Release strategy and npm naming are in `docs/design/06-implementation-plan.md`; **v1's top priority is that local-path installation works**.
