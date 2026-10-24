# 07 · Adapter contract (v1)

> All harness adapters depend on exactly two things: the `HarnMem` facade in `@harnmem/core` and the public types in `types.ts` (`HARNMEM_API_VERSION = 1`). Adapters **contain no retrieval/storage logic**; they only do three things: **injection**, **tool exposure**, and **lifecycle hooks**. That is how "what dsh writes, pi can search immediately" becomes a structural guarantee rather than a promise.

## 1. Engine facade (`packages/core/src/harnmem.ts`)

```ts
class HarnMem {
  static open(cfg: HarnMemConfig): Promise<HarnMem>;   // load config, init store, deploy prompts/data assets on first open

  // Read path
  sessionStart(input?: { sessionId?; cwd?; reason?: "session_start"|"resume"; date? }): Promise<ContextBlock>;
  ensureContext(reason?: ContextReason): Promise<ContextBlock>; // byte-stable hot index; empty store returns text:""
  search(opts: SearchOptions): Promise<SearchResult>;
  read(id: string, opts?: ReadOptions): Promise<ReadResult | null>;

  // Write path
  write(input: WriteInput): Promise<WriteResult>;
  importRecords(records: ImportRecord[], opts?: ImportOptions): Promise<ImportResult>;
  forget(id: string, opts?: { hard?: boolean }): Promise<ForgetResult>;
  restore(id: string): Promise<RestoreResult>;

  // Governance / observability
  stats(): Promise<Stats>;
  consolidate(opts?: ConsolidateOptions): Promise<ConsolidationReport>;
  rebuildIndex(): Promise<void>;

  // Session lifecycle (optional: adapters call these at session end)
  noteModelWrite(): void;      // model wrote a memory itself → mark context dirty and suppress auto-extraction
  sessionEnd(input: SessionEndInput): Promise<ExtractResult>;
  close(): Promise<void>;
}
```

**Conventions**

- Naming: early design drafts (01 §3 draft, 08 DSH design) used `buildContext` / `endSession` / `startSession`; the actual v1 facade methods are `ensureContext` / `sessionEnd` / `sessionStart`. Wherever the old names appear below (and in 06/08 and other docs), apply this mapping.
- The engine performs no network I/O; when it needs a model it only calls `cfg.llm` (injected by the adapter). Without `llm` → extraction returns `{status:"no_llm"}` and explicit write tools keep working.
- **Prompt/synonym assets**: on the first `open()`, `assets.ts` deploys the repository defaults `prompts/*.md` and `data/*.txt` (one synonym table per language, `synonyms.<lang>.txt`) to `<home>/prompts|data` (never overwriting user changes); extraction reads the `<home>` copy → repository default → the built-in prompt in `extract.ts` on every run. The loading contract (HTML comment stripping, `## system`/`## user` splitting, `{{placeholder}}` filling only in the user part) is in `prompts/README.md`.
- The engine never prints to stdout (avoiding corruption of the harness's TUI/JSON channel); logging goes through `cfg.log`.
- All writes are atomic (temp file + rename); concurrent writes to the same file keep the later one and record `WriteResult.warnings`; conflicts use bitemporal supersede to retain the old version (old files are not deleted). The `conflicts/` copy directory is reserved for v0.2 (not created in v1, see 02 §1).
- `ensureContext` results must be **byte-for-byte identical** when there are no writes, no day change, and no compaction (adapters own caching; the engine owns determinism).
- On version incompatibility `open()` throws `HarnMemError{code:"SCHEMA_NEWER"}`; the adapter should degrade to read-only and prompt the user to upgrade.

## 2. The four layers an adapter must implement

| Layer | Responsibility | Failure degradation |
|---|---|---|
| **Injection layer** | At session start, add `ensureContext()`'s text to the context (system-prompt append / hook additionalContext) | Injection failure does not affect the session; record it in the audit only |
| **Tool layer** | `memory_write / memory_search / memory_read / memory_forget / memory_status` (optionally `memory_restore / memory_consolidate / memory_pin`) | If tool registration fails, degrade to "injection only" mode |
| **Lifecycle layer** | Hooks for session start/turn end/compaction/end; call `ensureContext` to refresh and `sessionEnd` to trigger extraction | Extraction failure is audited only and never blocks exit |
| **Config layer** | Read harness user config + environment variables and map them into `HarnMemConfig` | Use defaults |

## 3. Unified tool semantics (same names across harnesses, optional prefix)

### `memory_write`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | `user\|feedback\|project\|reference` | yes | Four types; use `project` when unsure |
| `category` | string | no | `decision/convention/lesson/pitfall/state/profile/external` |
| `scope` | `auto\|user\|project` | no | default `auto` |
| `title` | string | yes | ≤80 characters, shown in the index |
| `description` | string | yes | ≤200 characters, one-sentence hook |
| `content` | string | yes | Markdown body, ≤64KB; feedback/project should include `**Why:**`/`**How to apply:**` |
| `tags` | string[] | no | lowercase kebab-case |
| `entities` | string[] | no | tools/libraries/repos/concepts |
| `importance` | 0–10 | no | heuristic default |
| `pinned` | boolean | no | user explicitly asked to "remember forever" |
| `links` / `supersedes` | string[] | no | old memory ids (taken from search results) |

Return text must be a **model-readable one-line conclusion**: `stored mem_xxx (NEW)` / `already exists mem_xxx (SKIP)` / `superseded mem_old → mem_new`, plus "use memory_read for details".

### `memory_search`
Parameters: `query` (required), `limit` (default 8), `scope`, `include_archived`, `as_of`, `entity`, `debug`. Returns JSON (see 03 §5.4); when `abstained:true`, tell the model "no sufficiently confident memories".

### `memory_read`
Parameters: `id`, `as_of?`, `include_history?`. Returns a frontmatter summary + body + `backlinks` + a `(historical)` marker.

### `memory_forget`
Parameters: `id`, `hard?`. Moves to `trash/` by default (30-day grace); `hard:true` physically deletes immediately (including the index), leaving only id/time/reason in the audit.

### `memory_status`
No parameters or `scope`. Returns a plain-language summary of `stats` (counts/capacity/pinned/health/last consolidation).

### 3.6 Enforcement surface: schema vs engine (added 2026-10-20)

Tool schemas (pi's TypeBox, Claude MCP's JSON Schema) are only **hints and type checks**, not a security boundary; the authoritative enforcement surface is the engine:

| Constraint | Enforced by | Evidence |
|---|---|---|
| Parameter types / enums / required | adapter schema | `packages/pi-harnmem/src/tools.ts`; 09 §3.2 (MCP inputSchema) |
| Four-type whitelist, scope/project resolution | **engine** `HarnMem.write()` | `packages/core/src/harnmem.ts` (write path); `types.ts` |
| title≤80 / description≤200 / content≤64KB / tag normalization | **engine** | `packages/core/src/frontmatter.ts`, `config.ts` `maxBodyBytes` |
| importance/confidence clamping, secret redaction, sensitive marking | **engine** | `packages/core/src/util.ts` / write entry |
| Dedupe/supersede decisions | **engine** | `packages/core/src/lifecycle.ts` `decideDedupe` |
| Tool return text | each adapter | `packages/pi-harnmem/src/format.ts` |

Corollary: **no adapter may rely on the schema alone to reject invalid values** (models/MCP clients can bypass schemas); the engine must re-validate and emit warnings. Known adapter schema defects (`importance` documented as 0..1, `memory_search.scope` enum including `auto`) are fixed on the pi side and do not affect engine semantics; the Claude MCP side is designed per this table to allow only `user|project|all`.

## 4. pi adapter (first, `packages/pi-harnmem`)

### 4.1 Event wiring (based on `docs/research/pi-extension-api.md`, verified experimentally)

| pi event/API | harnmem action | Notes |
|---|---|---|
| `factory(pi)` | Read config, register tools/commands/flags; **no I/O** | The factory also runs for invocations that never start a session; async factories are awaited before `session_start`, keep it <100ms |
| `session_start(reason)` | `HarnMem.open()`; `sessionStart({reason})` → build the snapshot; `ensureContext()` to get the injection block; start journal | Snapshot stays unchanged until `session_shutdown` |
| `before_agent_start` | Return `{ systemPrompt: e.systemPrompt + block }` (block is byte-stable); if dirty → rebuild before returning | Awaited every turn, must be <20ms (in-memory cache, no disk reads) |
| `turn_end` / `agent_settled` | Append to journal (memory + periodic flush); background extraction when needed (off by default) | Must not block |
| `session_before_compact` | Refresh the snapshot (`compaction` reason); may write a handoff to `state/handoff/` | Compaction changes history |
| `session_shutdown(reason)` | Only `reason==="quit"`: `sessionEnd()` with a self-imposed `Promise.race` timeout of **8s** (pi waits for shutdown without a timeout); other reasons only flush the journal | `reload/new/resume/fork` do no expensive work |
| `registerTool` | 5 tools (§3); `memory_*` prefix | TypeBox schemas; errors thrown |
| `registerCommand("memory")` | `status/search/forget/restore/consolidate/pin` subcommands | TUI uses `ctx.ui.notify`; print when there is no UI |
| `ctx.model` + `ctx.modelRegistry.getApiKey` + `complete()` | Inject an `LlmFn` into the engine (low reasoning effort) | No model/no key → `llm=null` |

### 4.2 Subagents and concurrency (important)

- pi-subagents: **background child sessions inherit the parent extension** (their hooks fire), while **foreground child agents do not inherit it**;
- Therefore: **only the root session may extract/consolidate/write**; child sessions are read-only (`readOnly` mode + skip `sessionEnd`). Detection: pi-subagents child markers / `ctx.sessionManager.getSessionId()` differing from the root + `PI_SUBAGENTS_*` environment variables (unverified; be conservative and skip extraction when unknown), never write twice.
- If a forked child session injected a different snapshot it would break the prefix cache: fork inherits the parent snapshot (or skips injection entirely), accepting the small cost.
- Multiple harnesses online at once: writes use atomic rename + `state/seq`; the index validates against the manifest seq; conflicting writes go to `conflicts/`.

### 4.3 Prefix cache (KV-cache)

The "Option P" from pi-memory must be replicated:
1. `session_start` / `session_before_compact` / this session's `memory_write` / day rollover → rebuild the snapshot;
2. Every other turn returns the same byte string (**forbidden** in per-turn text: timestamps, counters, random ordering);
3. A fixed caveat line at the snapshot tail (including the snapshot time, unchanged within the session);
4. Real-time tool results never enter the system prompt (only tool results).

### 4.4 Packaging

```jsonc
// packages/pi-harnmem/package.json
{
  "name": "pi-harnmem",
  "type": "module",
  "keywords": ["pi-package", "memory"],
  "pi": { "extensions": ["./dist/index.js"] },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-ai": "*", "typebox": "*" },
  "dependencies": { "@harnmem/core": "workspace:*" }
}
```

- Install: `pi install ./packages/pi-harnmem` (local) or, after publishing, `pi install npm:pi-harnmem`; `pi -e dist/index.js` loads it for a single run;
- The core package is a peer/normal dependency, and pi's jiti can load ESM JS; at publish time `@harnmem/core` must be a standalone npm package (or core could be bundled into pi-harnmem — is that easier for v1? — **v1 uses a separate package** so dsh/claude can reuse it).

### 4.5 Acceptance

- After `pi -p -e packages/pi-harnmem/dist/index.js "Remember: I prefer Chinese responses"`, a subsequent `pi -p "What language did I say I prefer?"` answers correctly;
- Injected content appears in the provider payload (verify once with `before_provider_request`);
- Two turns in the same session produce identical systemPrompt bytes (log assertion);
- After exit, `sessionEnd` returns within 8s and pi exits normally;
- Background subagents do not create duplicate memories (construct a subagent scenario to verify).

## 5. dsh adapter (second, detailed design in 08)

Key differences (from `docs/research/dsh-plugin-and-migration.md`):

- A DSH plugin = npm package + cordis plugin that **must use named exports** `name/inject/Config/apply` (`export default` loses `inject`); `package.json` needs `dsh.manifestVersion:1` + `dsh.bundle.patch: ./cordis.patch.yml`;
- Injection = `ctx.systemPrompt.section({name:"memory:index", order:4000, text: ...})`, **recomputed every step** — the adapter caches a snapshot internally to keep bytes stable within a session;
- Tools = `ctx.tools.register`; consolidation attaches to `ctx.on("agent/disposed")` with a background `ctx.get("llm").stream(...)`;
- Hooks: `agent/created`, `agent/session-start`, `agent/pre-step`, `session/event`, `agent/disposed`, `session/disposed`, `ctx.compaction`; cwd/sessionId come from `agent.session.header`;
- **Never write custom session events** (resume would refuse to read them); access `$DSH_HOME` with `node:fs`, not `ctx.fs`;
- Subagents: `delegationDepth > 0` is read-only — no writes, no extraction.

## 6. Claude Code adapter (third, route)

Claude Code has no npm plugin API but does have: hooks (`SessionStart` / `UserPromptSubmit` / `SessionEnd` / `PreCompact`) + an MCP server + skills/commands.

> **The authoritative design is `09-claude-adapter.md`** (`@harnmem/mcp` package = MCP stdio server + `hook.mjs <event>` entry point; hooks invoke `node .../hook.mjs` rather than CLI subcommands). This section keeps the early route and boundary notes; where they conflict, 09 wins.

Plan:

1. `harnmem mcp` subprocess: zero-dependency JSON-RPC over stdio exposing 5 tools + a `harnmem://memory/index` resource (the same `HarnMem` engine, no plugin required);
2. `SessionStart` hook: run `harnmem inject --format=hook-json` to output `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":...}}` (additionalContext is the officially supported injection field, ≤10KB);
3. `UserPromptSubmit` hook (optional): output recall results; `SessionEnd` hook: `harnmem extract --transcript <jsonl>` to trigger offline extraction (Claude's session jsonl can be reused by the importer directly);
4. Configuration: MCP config + hooks config in `~/.claude/settings.json`, written/printed by `harnmem init --harness claude`.

## 7. Config precedence (consistent across adapters)

```
CLI arguments / environment variables HARNMEM_HOME, HARNMEM_DISABLED
  > harness config (~/.pi/agent/harnmem.json / dsh profile config / ~/.claude/...)
  > project config (<repo>/.harnmem.json)
  > ~/.harnmem/config.json
  > built-in defaults
```

## 8. Adapter acceptance checklist (run through for every harness)

- [ ] Empty store injects 0 bytes without errors
- [ ] Write one memory → visible in a new session's injection (verify once cross-session and once cross-harness)
- [ ] `memory_search` hits a Chinese query (bigram works)
- [ ] Two turns in the same session inject identical bytes (cache stability)
- [ ] Session exit does not hang (timeout protection works)
- [ ] Read-only mode works (no llm / no write permission)
- [ ] Subagents/child sessions do not write duplicates
- [ ] After migrating old memories, old data is searchable and not duplicated## 4. pi adapter (first, packages/pi-harnmem)

Adapter packages are named <harness>-harnmem (pi-harnmem first, then dsh-harnmem, opencode-harnmem, claude-harnmem); harness-neutral packages stay under the @harnmem scope.adapters depend on exactly two things: the `HarnMem` facade in `@harnmem/core` and the public types in `types.ts` (`HARNMEM_API_VERSION = 1`). Adapters **contain no retrieval/storage logic**; they only do three things: **injection**, **tool exposure**, and **lifecycle hooks**. That is how "what dsh writes, pi can search immediately" becomes a structural guarantee rather than a promise.

## 1. Engine facade (`packages/core/src/harnmem.ts`)

```ts
class HarnMem {
  static open(cfg: HarnMemConfig): Promise<HarnMem>;   // load config, init store, deploy prompts/data assets on first open

  // Read path
  sessionStart(input?: { sessionId?; cwd?; reason?: "session_start"|"resume"; date? }): Promise<ContextBlock>;
  ensureContext(reason?: ContextReason): Promise<ContextBlock>; // byte-stable hot index; empty store returns text:""
  search(opts: SearchOptions): Promise<SearchResult>;
  read(id: string, opts?: ReadOptions): Promise<ReadResult | null>;

  // Write path
  write(input: WriteInput): Promise<WriteResult>;
  importRecords(records: ImportRecord[], opts?: ImportOptions): Promise<ImportResult>;
  forget(id: string, opts?: { hard?: boolean }): Promise<ForgetResult>;
  restore(id: string): Promise<RestoreResult>;

  // Governance / observability
  stats(): Promise<Stats>;
  consolidate(opts?: ConsolidateOptions): Promise<ConsolidationReport>;
  rebuildIndex(): Promise<void>;

  // Session lifecycle (optional: adapters call these at session end)
  noteModelWrite(): void;      // model wrote a memory itself → mark context dirty and suppress auto-extraction
  sessionEnd(input: SessionEndInput): Promise<ExtractResult>;
  close(): Promise<void>;
}
```

**Conventions**

- Naming: early design drafts (01 §3 draft, 08 DSH design) used `buildContext` / `endSession` / `startSession`; the actual v1 facade methods are `ensureContext` / `sessionEnd` / `sessionStart`. Wherever the old names appear below (and in 06/08 and other docs), apply this mapping.
- The engine performs no network I/O; when it needs a model it only calls `cfg.llm` (injected by the adapter). Without `llm` → extraction returns `{status:"no_llm"}` and explicit write tools keep working.
- **Prompt/synonym assets**: on the first `open()`, `assets.ts` deploys the repository defaults `prompts/*.md` and `data/*.txt` (one synonym table per language, `synonyms.<lang>.txt`) to `<home>/prompts|data` (never overwriting user changes); extraction reads the `<home>` copy → repository default → the built-in prompt in `extract.ts` on every run. The loading contract (HTML comment stripping, `## system`/`## user` splitting, `{{placeholder}}` filling only in the user part) is in `prompts/README.md`.
- The engine never prints to stdout (avoiding corruption of the harness's TUI/JSON channel); logging goes through `cfg.log`.
- All writes are atomic (temp file + rename); concurrent writes to the same file keep the later one and record `WriteResult.warnings`; conflicts use bitemporal supersede to retain the old version (old files are not deleted). The `conflicts/` copy directory is reserved for v0.2 (not created in v1, see 02 §1).
- `ensureContext` results must be **byte-for-byte identical** when there are no writes, no day change, and no compaction (adapters own caching; the engine owns determinism).
- On version incompatibility `open()` throws `HarnMemError{code:"SCHEMA_NEWER"}`; the adapter should degrade to read-only and prompt the user to upgrade.

## 2. The four layers an adapter must implement

| Layer | Responsibility | Failure degradation |
|---|---|---|
| **Injection layer** | At session start, add `ensureContext()`'s text to the context (system-prompt append / hook additionalContext) | Injection failure does not affect the session; record it in the audit only |
| **Tool layer** | `memory_write / memory_search / memory_read / memory_forget / memory_status` (optionally `memory_restore / memory_consolidate / memory_pin`) | If tool registration fails, degrade to "injection only" mode |
| **Lifecycle layer** | Hooks for session start/turn end/compaction/end; call `ensureContext` to refresh and `sessionEnd` to trigger extraction | Extraction failure is audited only and never blocks exit |
| **Config layer** | Read harness user config + environment variables and map them into `HarnMemConfig` | Use defaults |

## 3. Unified tool semantics (same names across harnesses, optional prefix)

### `memory_write`
| Parameter | Type | Required | Description |
|---|---|---|---|
| `type` | `user\|feedback\|project\|reference` | yes | Four types; use `project` when unsure |
| `category` | string | no | `decision/convention/lesson/pitfall/state/profile/external` |
| `scope` | `auto\|user\|project` | no | default `auto` |
| `title` | string | yes | ≤80 characters, shown in the index |
| `description` | string | yes | ≤200 characters, one-sentence hook |
| `content` | string | yes | Markdown body, ≤64KB; feedback/project should include `**Why:**`/`**How to apply:**` |
| `tags` | string[] | no | lowercase kebab-case |
| `entities` | string[] | no | tools/libraries/repos/concepts |
| `importance` | 0–10 | no | heuristic default |
| `pinned` | boolean | no | user explicitly asked to "remember forever" |
| `links` / `supersedes` | string[] | no | old memory ids (taken from search results) |

Return text must be a **model-readable one-line conclusion**: `stored mem_xxx (NEW)` / `already exists mem_xxx (SKIP)` / `superseded mem_old → mem_new`, plus "use memory_read for details".

### `memory_search`
Parameters: `query` (required), `limit` (default 8), `scope`, `include_archived`, `as_of`, `entity`, `debug`. Returns JSON (see 03 §5.4); when `abstained:true`, tell the model "no sufficiently confident memories".

### `memory_read`
Parameters: `id`, `as_of?`, `include_history?`. Returns a frontmatter summary + body + `backlinks` + a `(historical)` marker.

### `memory_forget`
Parameters: `id`, `hard?`. Moves to `trash/` by default (30-day grace); `hard:true` physically deletes immediately (including the index), leaving only id/time/reason in the audit.

### `memory_status`
No parameters or `scope`. Returns a plain-language summary of `stats` (counts/capacity/pinned/health/last consolidation).

### 3.6 Enforcement surface: schema vs engine (added 2026-10-20)

Tool schemas (pi's TypeBox, Claude MCP's JSON Schema) are only **hints and type checks**, not a security boundary; the authoritative enforcement surface is the engine:

| Constraint | Enforced by | Evidence |
|---|---|---|
| Parameter types / enums / required | adapter schema | `packages/pi-harnmem/src/tools.ts`; 09 §3.2 (MCP inputSchema) |
| Four-type whitelist, scope/project resolution | **engine** `HarnMem.write()` | `packages/core/src/harnmem.ts` (write path); `types.ts` |
| title≤80 / description≤200 / content≤64KB / tag normalization | **engine** | `packages/core/src/frontmatter.ts`, `config.ts` `maxBodyBytes` |
| importance/confidence clamping, secret redaction, sensitive marking | **engine** | `packages/core/src/util.ts` / write entry |
| Dedupe/supersede decisions | **engine** | `packages/core/src/lifecycle.ts` `decideDedupe` |
| Tool return text | each adapter | `packages/pi-harnmem/src/format.ts` |

Corollary: **no adapter may rely on the schema alone to reject invalid values** (models/MCP clients can bypass schemas); the engine must re-validate and emit warnings. Known adapter schema defects (`importance` documented as 0..1, `memory_search.scope` enum including `auto`) are fixed on the pi side and do not affect engine semantics; the Claude MCP side is designed per this table to allow only `user|project|all`.

## 4. pi adapter (first, `packages/pi-harnmem`)

### 4.1 Event wiring (based on `docs/research/pi-extension-api.md`, verified experimentally)

| pi event/API | harnmem action | Notes |
|---|---|---|
| `factory(pi)` | Read config, register tools/commands/flags; **no I/O** | The factory also runs for invocations that never start a session; async factories are awaited before `session_start`, keep it <100ms |
| `session_start(reason)` | `HarnMem.open()`; `sessionStart({reason})` → build the snapshot; `ensureContext()` to get the injection block; start journal | Snapshot stays unchanged until `session_shutdown` |
| `before_agent_start` | Return `{ systemPrompt: e.systemPrompt + block }` (block is byte-stable); if dirty → rebuild before returning | Awaited every turn, must be <20ms (in-memory cache, no disk reads) |
| `turn_end` / `agent_settled` | Append to journal (memory + periodic flush); background extraction when needed (off by default) | Must not block |
| `session_before_compact` | Refresh the snapshot (`compaction` reason); may write a handoff to `state/handoff/` | Compaction changes history |
| `session_shutdown(reason)` | Only `reason==="quit"`: `sessionEnd()` with a self-imposed `Promise.race` timeout of **8s** (pi waits for shutdown without a timeout); other reasons only flush the journal | `reload/new/resume/fork` do no expensive work |
| `registerTool` | 5 tools (§3); `memory_*` prefix | TypeBox schemas; errors thrown |
| `registerCommand("memory")` | `status/search/forget/restore/consolidate/pin` subcommands | TUI uses `ctx.ui.notify`; print when there is no UI |
| `ctx.model` + `ctx.modelRegistry.getApiKey` + `complete()` | Inject an `LlmFn` into the engine (low reasoning effort) | No model/no key → `llm=null` |

### 4.2 Subagents and concurrency (important)

- pi-subagents: **background child sessions inherit the parent extension** (their hooks fire), while **foreground child agents do not inherit it**;
- Therefore: **only the root session may extract/consolidate/write**; child sessions are read-only (`readOnly` mode + skip `sessionEnd`). Detection: pi-subagents child markers / `ctx.sessionManager.getSessionId()` differing from the root + `PI_SUBAGENTS_*` environment variables (unverified; be conservative and skip extraction when unknown), never write twice.
- If a forked child session injected a different snapshot it would break the prefix cache: fork inherits the parent snapshot (or skips injection entirely), accepting the small cost.
- Multiple harnesses online at once: writes use atomic rename + `state/seq`; the index validates against the manifest seq; conflicting writes go to `conflicts/`.

### 4.3 Prefix cache (KV-cache)

The "Option P" from pi-memory must be replicated:
1. `session_start` / `session_before_compact` / this session's `memory_write` / day rollover → rebuild the snapshot;
2. Every other turn returns the same byte string (**forbidden** in per-turn text: timestamps, counters, random ordering);
3. A fixed caveat line at the snapshot tail (including the snapshot time, unchanged within the session);
4. Real-time tool results never enter the system prompt (only tool results).

### 4.4 Packaging

```jsonc
// packages/pi-harnmem/package.json
{
  "name": "pi-harnmem",
  "type": "module",
  "keywords": ["pi-package", "memory"],
  "pi": { "extensions": ["./dist/index.js"] },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-ai": "*", "typebox": "*" },
  "dependencies": { "@harnmem/core": "workspace:*" }
}
```

- Install: `pi install ./packages/pi-harnmem` (local) or, after publishing, `pi install npm:pi-harnmem`; `pi -e dist/index.js` loads it for a single run;
- The core package is a peer/normal dependency, and pi's jiti can load ESM JS; at publish time `@harnmem/core` must be a standalone npm package (or core could be bundled into pi-harnmem — is that easier for v1? — **v1 uses a separate package** so dsh/claude can reuse it).

### 4.5 Acceptance

- After `pi -p -e packages/pi-harnmem/dist/index.js "Remember: I prefer Chinese responses"`, a subsequent `pi -p "What language did I say I prefer?"` answers correctly;
- Injected content appears in the provider payload (verify once with `before_provider_request`);
- Two turns in the same session produce identical systemPrompt bytes (log assertion);
- After exit, `sessionEnd` returns within 8s and pi exits normally;
- Background subagents do not create duplicate memories (construct a subagent scenario to verify).

## 5. dsh adapter (second, detailed design in 08)

Key differences (from `docs/research/dsh-plugin-and-migration.md`):

- A DSH plugin = npm package + cordis plugin that **must use named exports** `name/inject/Config/apply` (`export default` loses `inject`); `package.json` needs `dsh.manifestVersion:1` + `dsh.bundle.patch: ./cordis.patch.yml`;
- Injection = `ctx.systemPrompt.section({name:"memory:index", order:4000, text: ...})`, **recomputed every step** — the adapter caches a snapshot internally to keep bytes stable within a session;
- Tools = `ctx.tools.register`; consolidation attaches to `ctx.on("agent/disposed")` with a background `ctx.get("llm").stream(...)`;
- Hooks: `agent/created`, `agent/session-start`, `agent/pre-step`, `session/event`, `agent/disposed`, `session/disposed`, `ctx.compaction`; cwd/sessionId come from `agent.session.header`;
- **Never write custom session events** (resume would refuse to read them); access `$DSH_HOME` with `node:fs`, not `ctx.fs`;
- Subagents: `delegationDepth > 0` is read-only — no writes, no extraction.

## 6. Claude Code adapter (third, route)

Claude Code has no npm plugin API but does have: hooks (`SessionStart` / `UserPromptSubmit` / `SessionEnd` / `PreCompact`) + an MCP server + skills/commands.

> **The authoritative design is `09-claude-adapter.md`** (`@harnmem/mcp` package = MCP stdio server + `hook.mjs <event>` entry point; hooks invoke `node .../hook.mjs` rather than CLI subcommands). This section keeps the early route and boundary notes; where they conflict, 09 wins.

Plan:

1. `harnmem mcp` subprocess: zero-dependency JSON-RPC over stdio exposing 5 tools + a `harnmem://memory/index` resource (the same `HarnMem` engine, no plugin required);
2. `SessionStart` hook: run `harnmem inject --format=hook-json` to output `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":...}}` (additionalContext is the officially supported injection field, ≤10KB);
3. `UserPromptSubmit` hook (optional): output recall results; `SessionEnd` hook: `harnmem extract --transcript <jsonl>` to trigger offline extraction (Claude's session jsonl can be reused by the importer directly);
4. Configuration: MCP config + hooks config in `~/.claude/settings.json`, written/printed by `harnmem init --harness claude`.

## 7. Config precedence (consistent across adapters)

```
CLI arguments / environment variables HARNMEM_HOME, HARNMEM_DISABLED
  > harness config (~/.pi/agent/harnmem.json / dsh profile config / ~/.claude/...)
  > project config (<repo>/.harnmem.json)
  > ~/.harnmem/config.json
  > built-in defaults
```

## 8. Adapter acceptance checklist (run through for every harness)

- [ ] Empty store injects 0 bytes without errors
- [ ] Write one memory → visible in a new session's injection (verify once cross-session and once cross-harness)
- [ ] `memory_search` hits a Chinese query (bigram works)
- [ ] Two turns in the same session inject identical bytes (cache stability)
- [ ] Session exit does not hang (timeout protection works)
- [ ] Read-only mode works (no llm / no write permission)
- [ ] Subagents/child sessions do not write duplicates
- [ ] After migrating old memories, old data is searchable and not duplicated
