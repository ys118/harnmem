# pi 1.3.0 extension API — research for a cross-harness memory plugin

Status: verified against local source. Date: 2026-10-20.
Sources (all local):
- `<pi-repo>\packages\coding-agent\docs\extensions.md` (3023 lines), `docs\packages.md`, `docs\settings.md`, `docs\compaction.md`, `docs\session-format.md`
- `<pi-repo>\packages\coding-agent\src\core\extensions\types.ts` (1797 lines) — ground-truth `ExtensionAPI`/events/tools
- `<pi-repo>\packages\coding-agent\src\core\session-manager.ts` (ReadonlySessionManager)
- Installed package: `C:\Program Files\nodejs\node_modules\@earendil-works\pi-coding-agent` (v1.3.0)
- Reference plugin: `~\.pi\agent\npm\node_modules\pi-memory\index.ts` (2431 lines); `pi-subagents` docs at `...\node_modules\pi-subagents\docs\`
- Live probe: `spikes/pi-probe` in this repo (ran headless, see §13)

Unverified items are marked **[unverified]**.

---

## 0. TL;DR

- pi extensions are plain TS/JS modules loaded with **jiti** (no build step), default-exporting `function (pi: ExtensionAPI)`.
- A memory plugin gets: `session_start` / `session_shutdown`, per-turn `before_agent_start` (system-prompt append + message injection), `input`, `turn_end`, `session_before_compact`, `tool_call`/`tool_result` interception, `registerTool`, `registerCommand`, `ctx.ui.setStatus`, readable session manager, and one-shot LLM calls via `complete()` from `@earendil-works/pi-ai/compat`.
- The system prompt must be **byte-stable across turns** for prefix caching. pi-memory's proven pattern ("Option P") is: snapshot memory text at deliberate checkpoints, append identical bytes every turn (§4.3).
- Every hook is on the single JS thread; long work must be self-bounded. `session_shutdown` handlers are awaited **with no timeout** by pi core (§6.3).
- pi-subagents **background** children load the parent's ambient extensions; foreground children do not (§11) — the memory plugin must be idempotent/dedupe per session.

---

## 1. Packaging, discovery, install

### 1.1 Extension module shape
```ts
// index.ts
import { Type } from "typebox";           // or from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {   // may be async; pi awaits it before startup continues
  pi.on("session_start", async (_event, ctx) => { /* ... */ });
  pi.registerTool({ /* ... */ });
  pi.registerCommand("memory-status", { description: "…", handler: async (_args, ctx) => {} });
}
```
`ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`. Loaded via jiti, so `.ts` runs directly. Multiple entrypoints per extension file are supported via named exports of extension factories (inline extensions, SDK only).

### 1.2 Discovery locations (docs §Extension Locations)
| Location | Scope |
|---|---|
| `~/.pi/agent/extensions/*.ts` | global |
| `~/.pi/agent/extensions/*/index.ts` | global (dir form, multi-file OK) |
| `.pi/extensions/*.ts` / `.pi/extensions/*/index.ts` | project-local, only after project trust |
plus `settings.json` `"extensions": ["/abs/path.ts", "dir"]` and `"packages": [...]`.

### 1.3 Package manifest (`docs/packages.md:116-173`)
```json
{
  "name": "pi-harnmem",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],       // globs + "!exclude" supported; paths relative to pkg root
    "skills": [], "prompts": [], "themes": []
  },
  "dependencies": {},
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-agent-core": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```
- No `pi` manifest → convention dirs `extensions/`, `skills/`, `prompts/`, `themes/` are auto-discovered.
- Core pi packages are **bundled by pi**; list them as `peerDependencies` `"*"` and do not bundle. Other runtime deps go in `dependencies` (pi runs `npm install --omit=dev` on install).
- Filtering after install: `settings.json` packages object form (`{"source": "...", "extensions": ["*.ts", "!legacy.ts"], "skills": []}`); `+path` forces include, `-path` excludes.
- `pi config` TUI enables/disables resources per package (global, `-l` for project).
- Dedupe: same package in global+project → project wins unless `autoload:false` (delta). Identity: npm name / git URL / resolved local path.
- Extension-level install uses `pi install npm:@foo/bar@1.0.0`, `git:github.com/user/repo@v1`, `https://…`, `/abs/path`, `./rel/path`. `pi remove`, `pi list`, `pi update --extensions`.
- Locations: user npm installs → `~/.pi/agent/npm/` (`node_modules/<pkg>`), git clones → `~/.pi/agent/git/<host>/<path>`; project → `.pi/npm`, `.pi/git`. Local paths are referenced in settings, **not copied**.
- `pi install X` writes the source string into `settings.json` `packages` (user file by default, project with `-l`). This is how `pi-memory` appears there.
- `pi -e ./file.ts` (== `--extension`) loads a one-off extension (also `-e npm:@foo/bar` → temp install for that run). Multiple `-e` allowed. `--no-extensions` disables discovery/auto-load, explicit `-e` still works.
- Multi-file/monorepo: a dir with `index.ts` + sibling `.ts` modules is fully supported (relative imports work; jiti compiles them). A `package.json` with `pi.extensions` handles `node_modules` deps (`npm install` in that dir).
- Load order/priority across extensions: **not documented [unverified]**; `before_agent_start` chaining order = load order, each handler sees prior system-prompt changes (`event.systemPrompt`).

---

## 2. ExtensionAPI surface (exact, `types.ts:1252-1506`)

```ts
export interface ExtensionAPI {
  // events — full list in §3; each overload is
  //   on(event, handler: ExtensionHandler<E, R>) => void
  // ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R|void> | R | void;
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
  // … 40+ overloads, see §3

  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
    tool: ToolDefinition<TParams, TDetails, TState>): void;

  registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
  // RegisteredCommand = { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>|void }
  registerShortcut(shortcut: KeyId, options: { description?: string; handler: (ctx) => Promise<void>|void }): void;
  registerFlag(name: string, options:
    | { description?: string; type: "boolean"; default?: boolean }
    | { description?: string; type: "string"; default?: string }): void;
  getFlag(name: string): boolean | string | undefined;

  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;
  registerMarkdownTransformer(transformer: MarkdownTransformer): void;
  registerEntryRenderer<T = unknown>(customType: string, renderer: EntryRenderer<T>): void;

  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
  sendUserMessage(content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
  appendEntry<T = unknown>(customType: string, data?: T): void;   // durable, NOT in LLM context

  setSessionName(name: string): void;  getSessionName(): string | undefined;
  setLabel(entryId: string, label: string | undefined): void;
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;
  getActiveTools(): string[];  getAllTools(): ToolInfo[];  setActiveTools(names: string[]): void;
  getCommands(): SlashCommandInfo[];

  setModel(model: Model<any>): Promise<boolean>;
  getThinkingLevel(): ThinkingLevel;  setThinkingLevel(level: ThinkingLevel): void;
  registerProvider(provider: Provider): void;
  registerProvider(name: string, config: ProviderConfig): void;  unregisterProvider(name: string): void;

  events: EventBus;   // cross-extension pub/sub
}
```

`ExtensionCommandContext` (commands only) adds: `newSession({parentSession?, withSession?})`, `fork(entryId, {position, withSession?})`, `switchSession(path, {withSession?})`, `reload(): Promise<void>`. `withSession` receives a `ReplacedSessionContext` whose `sendMessage`/`sendUserMessage` return Promises. Do not call these from event handlers (deadlock).

### 2.1 ExtensionContext (`types.ts:309-349`, docs `extensions.md:960+`)
```ts
interface ExtensionContext {
  ui: ExtensionUIContext;  mode: "tui"|"rpc"|"json"|"print";  hasUI: boolean;
  cwd: string;
  sessionManager: ReadonlySessionManager;
  modelRegistry: ModelRegistry;         // ctx.modelRegistry.getApiKey(model) => Promise<string|undefined>
  model: Model<any> | undefined;
  scopedModels: readonly ScopedModel[];
  thinkingLevel?: ThinkingLevel;
  isIdle(): boolean;  isProjectTrusted(): boolean;
  signal: AbortSignal | undefined;      // defined during turn events
  abort(): void;  hasPendingMessages(): boolean;  shutdown(): void;
  getContextUsage(): ContextUsage | undefined;   // { tokens: number|null, contextWindow, percent: number|null }
  compact(options?: { customInstructions?: string; onComplete?; onError? }): void;
  getSystemPrompt(): string;
}
```

---

## 3. Events (all names, exact payloads)

Lifecycle overview (`extensions.md:275+`):
`project_trust → session_start{startup} → resources_discover →` prompt →
`input → before_agent_start → agent_start → [turn_start → context → (LLM) → message_start/update/end → tool_call → tool_execution_* → tool_result → turn_end]* → agent_end → agent_settled`;
plus `session_shutdown`, compaction/tree/fork/switch events, `model_select`, `thinking_level_select`, `user_bash`, `ui_prompt_start/end`.

### 3.1 Session events (`types.ts:563-681`)
```ts
SessionStartEvent   { type:"session_start"; reason:"startup"|"reload"|"new"|"resume"|"fork"; previousSessionFile?: string }
SessionInfoChangedEvent { type:"session_info_changed"; name: string | undefined }
SessionBeforeSwitchEvent { type:"session_before_switch"; reason:"new"|"resume"; targetSessionFile?: string } → { cancel? }
SessionBeforeForkEvent   { type:"session_before_fork"; entryId: string; position:"before"|"at" } → { cancel?, skipConversationRestore? }
SessionBeforeCompactEvent{ type:"session_before_compact"; preparation: CompactionPreparation; branchEntries: SessionEntry[];
                           customInstructions?: string; reason:"manual"|"threshold"|"overflow"; willRetry: boolean; signal: AbortSignal }
                         → { cancel?: boolean; compaction?: CompactionResult }  // custom summary
SessionCompactEvent      { type:"session_compact"; compactionEntry: CompactionEntry; fromExtension: boolean; reason; willRetry }
SessionCompactFailedEvent{ type:"session_compact_failed"; reason; errorMessage?: string; aborted; willRetry; fromExtension }
SessionShutdownEvent     { type:"session_shutdown"; reason:"quit"|"reload"|"new"|"resume"|"fork"; targetSessionFile?: string }
SessionBeforeTreeEvent   { type:"session_before_tree"; preparation: TreePreparation; signal } → { cancel?, summary?, customInstructions?, replaceInstructions?, label? }
SessionTreeEvent         { type:"session_tree"; newLeafId: string|null; oldLeafId: string|null; summaryEntry?: BranchSummaryEntry; fromExtension? }
```
Compaction events also in `docs/compaction.md`; a fork reloads extension instances: `session_shutdown(old)` → `session_start{fork}`.

### 3.2 Agent/turn/message/tool events (`types.ts:687-870`)
```ts
ContextEvent            { type:"context"; messages: AgentMessage[] }  → { messages?: AgentMessage[] }   // before EVERY LLM call; can rewrite history
BeforeProviderRequestEvent { type:"before_provider_request"; payload: unknown }  → unknown (replace payload)
BeforeProviderHeadersEvent { type:"before_provider_headers"; headers } (mutate in place; null deletes)
AfterProviderResponseEvent { type:"after_provider_response"; status; headers }
BeforeAgentStartEvent   { type:"before_agent_start"; prompt: string; images?: ImageContent[];
                          systemPrompt: string; systemPromptOptions: BuildSystemPromptOptions }
                        → { message?: Pick<CustomMessage,...>; systemPrompt?: string }     // chained
AgentStartEvent { type:"agent_start" }
AgentEndEvent   { type:"agent_end"; messages: AgentMessage[] }
AgentSettledEvent { type:"agent_settled" }                         // no retry/compact/queued continuation will run
TurnStartEvent  { type:"turn_start"; turnIndex; timestamp }
TurnEndEvent    { type:"turn_end"; turnIndex; message: AgentMessage; toolResults: ToolResultMessage[] }
MessageStartEvent { type:"message_start"; message }
MessageUpdateEvent{ type:"message_update"; message; assistantMessageEvent }
MessageEndEvent   { type:"message_end"; message } → { message?: AgentMessage }   // same role required
ToolExecutionStartEvent { type:"tool_execution_start"; toolCallId; toolName; args }
ToolExecutionUpdateEvent{ type:"tool_execution_update"; toolCallId; toolName; args; partialResult }
ToolExecutionEndEvent   { type:"tool_execution_end"; toolCallId; toolName; result; isError }
ToolCallEvent   { type:"tool_call"; toolCallId; toolName; input }       // per-tool discriminated payloads (bash/edit/…)
                → { block?: boolean; reason?: string; terminate?: boolean }   // mutate event.input in place to rewrite args
ToolResultEvent { type:"tool_result"; toolCallId; toolName; input: Record<string,unknown>;
                  content: (TextContent|ImageContent)[]; isError: boolean; usage?: Usage; details? }
                → { content?; details?; isError?; usage? }              // partial patch
ModelSelectEvent { type:"model_select"; model; previousModel; source:"set"|"cycle"|"restore" }
ThinkingLevelSelectEvent { type:"thinking_level_select"; level; previousLevel }
InputEvent { type:"input"; text: string; images?; source; streamingBehavior?:"steer"|"followUp" }
           → { action:"continue" } | { action:"transform"; text? } | { action:"handled" }   // intercept/rewrite user input
UIPromptStartEvent/EndEvent { reason:"ui_prompt"; kind:"select"|"confirm"|"input"|"editor"|"custom"; title? }
```
Memory-relevant mapping: session start/end → §3.1; per-turn passive recall → `before_agent_start` (+ `input` for prompt text pre-turn); transcript/tool observation → `tool_result`, `turn_end`, `message_end`; pre-compaction capture → `session_before_compact` (+ return custom summary); session id/cwd → `ctx.sessionManager`/`ctx.cwd`.

---

## 4. Context injection & prefix-cache stability

### 4.1 Three ways to add context
1. **System prompt append** — return `{ systemPrompt }` from `before_agent_start`; chained across extensions; `ctx.getSystemPrompt()` shows the chain so far. Payload-level: `before_provider_request` can rewrite the final provider payload (used by pi-memory for diagnostics only; review it does not rely on this).
2. **Message injection** — return `{ message: { customType, content, display } }` from `before_agent_start` (persistent custom message in session, sent to LLM), or `pi.sendMessage(msg, { deliverAs, triggerTurn })` any time.
3. **History rewrite** — `context` event: `return { messages: [...] }` before each LLM call (can splice/trim). Rewriting history is cache-hostile; use for recall insertion only when unavoidable.

Appending to *the current user turn*: no hook appends text to the user message itself. Options: `input` event transform (before turn), `context` rewrite of the last user message, or `before_agent_start` `message` injection (a custom message after the user prompt). Disk/`--append-system-prompt` style injection into system prompt is the natural "always-on index" slot.

Built-in context-file mechanism: `systemPromptOptions` (`before_agent_start`) exposes `.customPrompt`, `.selectedTools`, `.toolSnippets`, `.promptGuidelines`, `.appendSystemPrompt`, `.cwd`, `.contextFiles` (AGENTS.md + loaded context files), `.skills`. pi already loads `AGENTS.md` etc. into the system prompt; a project can add files via `contextFiles` settings (`docs/settings.md`) instead of a plugin. `ctx.getSystemPromptOptions()` gives the same object in commands.

### 4.2 Why byte-stability matters
Prefix/KV cache (DeepSeek, vLLM, llama.cpp, Anthropic) keys on the request prefix. If the injected system-prompt block changes each turn (timestamps, new memories), the cache misses from that point on, costing the whole system prompt + history re-read every turn.

### 4.3 pi-memory's proven mechanism ("Option P", `index.ts:1384-1590`)
```ts
// comments verbatim: "The system prompt must be byte-stable across turns so local prefix caches
// don't invalidate the entire conversation tail on each turn. We snapshot the memory context at
// deliberate checkpoints (session_start, session_before_compact, long_term writes, day rollover)
// and emit the same bytes for every turn in between."
let memorySnapshot: string | null = null;
let snapshotDirty = false;
function refreshMemorySnapshot(reason: string) { memorySnapshot = buildMemoryContext(""); …snapshotDirty=false; }

// reset points (grep): refreshMemorySnapshot("session_start") on session_start (2 call sites),
// refreshMemorySnapshot("session_before_compact") on pre-compaction,
// snapshotDirty = true on memory_write tools and long-term writes.
pi.on("before_agent_start", async (event) => {
  const needsRefresh = memorySnapshot === null || snapshotDirty || snapshotTakenOnDate !== today;
  if (needsRefresh) refreshMemorySnapshot(/* "long_term_write" | "day_rollover" */);
  const memoryContext = memorySnapshot ?? "";
  return { systemPrompt: event.systemPrompt + headerLines.join("\n") + memoryContext };
});
```
It also emits a caveat ("Snapshot <reason> at <ts>. Use memory_read/memory_search for authoritative latest state") so staleness is explainable to the model. Frontmatter for us: (a) capture hot index snapshot on `session_start`, (b) refresh only on memory write / day rollover / after compaction, (c) never embed per-turn timestamps or counters in the injected block, (d) put volatile recall in tool results (memory_search) not the system prompt.

---

## 5. Tool registration

```ts
interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
  name: string; label: string; description: string;
  promptSnippet?: string;            // one-liner in default system prompt's Available tools
  promptGuidelines?: string[];       // bullets for Guidelines section
  parameters: TParams;               // TypeBox schema
  constrainedSampling?: false | ConstrainedSamplingConfig;
  renderShell?: "default" | "self";
  prepareArguments?: (args: unknown) => Static<TParams>;   // shim before validation
  executionMode?: "sequential" | "parallel";
  execute(toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined,
          onUpdate: AgentToolUpdateCallback<TDetails> | undefined, ctx: ExtensionContext
  ): Promise<AgentToolResult<TDetails>>;   // { content: (TextContent|ImageContent)[]; details?: TDetails; isError?; usage? }
  renderCall?(args, theme, context): Component;
  renderResult?(result, options, theme, context): Component;
}
```
- Schema style: **TypeBox** (`import { Type } from "typebox"`, docs "Available Imports"; `@earendil-works/pi-ai` also re-exports `Type`/`StringEnum` and pi-memory uses that — both work, probe used pi-ai's re-export).
- **Errors:** `throw` inside `execute` → result `isError:true`, thrown message reported to the LLM, run continues (`extensions.md:2017`; also line 2926). Do not return an "error string" as success.
- Streaming progress: `onUpdate?.({ content: [{type:"text",text:"Working…"}] })`.
- **Permission/safety:** `tool_call` event can `return { block:true, reason }` (and `terminate`), or **mutate `event.input` in place** to rewrite args; `tool_result` can patch content/details/isError/usage before it reaches the model/TUI. Built-in tools can be overridden by registering the same name (docs §Overriding built-in tools; TUI warning; `--no-builtin-tools` keeps custom tools). `pi.getActiveTools()/setActiveTools()`/`executionMode` for gating.
- TUI: tools render with built-in shell by default; `renderCall`/`renderResult` for custom rows (needs `@earendil-works/pi-tui` `Text` etc.). Namespacing by prefix recommended (`harnmem_write`).

## 6. Calling an LLM from an extension

```ts
import { type Message, StringEnum, Type } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const model = ctx.model ?? ctx.modelRegistry.find(provider, modelId);   // ctx.model is active model
const apiKey = await ctx.modelRegistry.getApiKey(model);               // resolves configured auth
const res = await complete(
  model,
  { systemPrompt: EXTRACT_SYSTEM, messages: [{ role:"user", content:[{type:"text",text:transcript}], timestamp: Date.now() }] },
  { apiKey, reasoningEffort: "low" },
);
const text = res.content.filter(c => c.type === "text").map(c => c.text).join("\n");
// res.usage available (Usage: input/output/cacheRead/cacheWrite tokens)
```
This is exactly pi-memory's exit-summary call (`index.ts:467-471`, model resolution 374-405). Notes:
- Model resolution falls back: explicit `PROVIDER/MODEL` env/settings spec via `modelRegistry.find(provider, id)`; else `ctx.model`; api key via `modelRegistry.getApiKey(model)` (with `getApiKeyForProvider` fallback).
- `reasoningEffort: "low"` is honored by pi-ai where supported (cheap extraction). No built-in "background job" API — use `setTimeout`/promise with self-timeout, and `ctx.signal` for abort-aware work during turns.
- Usage: `res.usage`; per-session cumulative usage also in session entries (`ctx.getContextUsage()` for context only).
- **Shutdown hazard (`pi-memory:1490-1502`, verified code comment):** "pi core awaits shutdown handlers with no timeout, so a hanging provider would otherwise block quitting indefinitely." pi-memory races the summary against a self-imposed timeout (`setTimeout`, default a few seconds) and drops late results. Do the same.
- Cheapest background extraction: kick it off in `session_shutdown` (reason `quit`) or `turn_end` with an unref'd timer; never `await` unbounded work in `before_agent_start` (blocks the turn until it resolves; pi awaits async handlers).
- **Unverified [unverified]:** official cancellation API for `complete` beyond passing an AbortSignal (pi-ai `complete(model, ctx, options)` accepts `signal` in recent versions; not confirmed in v1.3.0 typings here).

## 7. Session/environment access

`ctx.sessionManager: ReadonlySessionManager` = `Pick<SessionManager, "getCwd" | "getSessionDir" | "getSessionId" | "getSessionFile" | "getLeafId" | "getLeafEntry" | "getEntry" | "getLabel" | "getBranch" | "buildContextEntries" | "getHeader" | "getEntries" | "getTree" | "getSessionName">` (`session-manager.ts:190-206`).
- `getSessionId()`: UUIDv7 string (probe: <uuid>). `getSessionFile()`: path or **`undefined` when `--no-session`/ephemeral** (probe hit this).
- `getEntries()`: all `SessionEntry[]`; `getBranch()`: current branch; `buildContextEntries()`: branch with compaction applied (this is what the model sees — use for transcript extraction).
- `getHeader()`: session header (id, cwd, timestamps, model); `getContextUsage()` on ctx for tokens/window/percent.
- Assistant/user/tool messages in `buildContextEntries()`; `turn_end.message` + `toolResults` for incremental capture; `session_compact` gives `compactionEntry.summary` + `tokensBefore`.
- `ctx.cwd`, `ctx.mode` (`tui|rpc|json|print`), `hasUI`, `isProjectTrusted()`, `getSystemPrompt()`, `abort()`, `isIdle()`, `hasPendingMessages()`.

## 8. Config for extensions

- **No direct settings-API on ExtensionAPI/Context** (verified: no `settingsManager` in `types.ts`). Options:
  1. `pi.registerFlag("memory", { type:"boolean", default:true })` + `pi.getFlag("memory")` → real CLI flags (`--memory`), auto-documented in help? [flag help rendering unverified].
  2. Read pi settings yourself: `import { getAgentDir, CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent"`; global settings at `join(getAgentDir(), "settings.json")` (`~/.pi/agent/settings.json`), project at `join(ctx.cwd, CONFIG_DIR_NAME, "settings.json")`; guard project reads with `ctx.isProjectTrusted()`.
  3. Own config file: `join(getAgentDir(), "harnmem.json")` or `.pi/harnmem.json` for project overrides; env-var overrides like pi-memory (`PI_MEMORY_*` pattern: env > project > global > defaults).
  4. `pi config` only toggles which package resources load — it is not an options UI for extensions (no per-extension settings schema shown in docs).
- User-facing toggles: `registerCommand` (`/memory status|on|off`) + `ctx.ui.select/confirm/input/editor`; persist via `pi.appendEntry(customType, data)` (session-scoped, not LLM context) or own JSON file.

## 9. UI (minimal, non-disruptive)

```ts
if (ctx.hasUI) {
  ctx.ui.notify("Memory: 42 entries indexed", "info");                 // toast-ish log
  ctx.ui.setStatus("harnmem", "🧠 42 idx · 3 new");                      // footer/status bar, persistent, undefined clears
  ctx.ui.setWidget("harnmem", ["Memory: 42 entries", "last write 12s ago"]);       // above editor
  ctx.ui.setWidget("harnmem", [lines...], { placement: "belowEditor" });           // below editor
  ctx.ui.setWidget("harnmem", (tui, theme) => new Text(theme.fg("accent","…"), 0, 0));
  ctx.ui.setTitle("pi · harnmem");
}
```
Full UI context includes `select/confirm/input/editor/custom` (overlay), `setFooter`, `setHeader`, `setWorkingMessage/Indicator`, autocomplete providers, editor component, themes (`ExtensionUIContext`, `types.ts:133-284`). Guard dialog APIs with `hasUI`; `custom()`/components only `mode === "tui"`. In print/json mode `notify/setStatus/setWidget` are no-ops (RPC supports some). For memory status: `setStatus` (one line) is the least intrusive; `setWidget` for a small index panel.

## 10. Testing / verification

- Headless: `pi -p "prompt"` (print mode, no UI, exits). `--mode json` for machine-readable; `--no-session` ephemeral; `pi -e ./ext.ts` one-off load; `--no-extensions` to isolate.
- Extension unit tests outside pi: the factory is plain TS; extract logic into pure modules (no pi runtime imports at module top, `import type` only) and run with vitest/node — **this is the recommended split for harnmem core**. [No pi-provided mock server/test-utils documented; unverified.]
- Integration: run `pi -p --no-session -e ./probe -p "…"` against a cheap model and assert log/output (see §13). Provider config: user default `<provider>` / `<model>`; auth via stored login or `<PROVIDER>_API_KEY` (not present in this shell env; probe still worked via pi's stored auth — do not print keys).
- Debug: no documented `PI_DEBUG` flag [unverified]; write your own log file under the agent dir (`~/.pi/agent/…`) and gate by env (`HARNMEM_DEBUG=1`). `before_provider_request` is the documented hook for inspecting serialization/cache behavior (`extensions.md:720`).
- 71 example extensions ship in the installed package: `…\pi-coding-agent\examples\extensions\` (source refs: `tool-override.ts`, `read.ts`, `bash.ts`, …); ground truth types in `dist/index.d.ts`.

## 11. Subagents (pi-subagents 0.79.1) and our hooks

From `…\pi-subagents\docs\agents.md:424` (verified): extension loading for children —
- `extensions` omitted → **background child loads the parent's ambient extensions**;
- `extensions: []` → none; explicit list → exactly those;
- **foreground children never load ambient extensions**;
- `subagentOnlyExtensions` = extension paths loaded only in that agent's child sessions (tools unavailable to main agent);
- hosts can `registerRequiredChildExtensions({sessionId, extensions:[{id,path}], requireForAllRunners?})` to force a plugin into every child.
- Cache note (`tool-reference.md:145`): "Another extension that returns a replacement `systemPrompt` from `before_agent_start` in the child replaces the parent's prompt and loses the cache." A forked child inherits the parent's prompt+history and reuses its provider cache; if our plugin injects a *different* memory snapshot in the child, that fork cache is lost — preferably inject the identical snapshot in forked children, or accept the cost.
- Implication for harnmem: in background child sessions our extension WILL fire `session_start`/`before_agent_start` (ambient inheritance). Detect child sessions (presence of pi-subagents' child markers / different session id / `PI_SUBAGENTS_*` env [unverified]) and dedupe writes: only the root session should trigger extraction/consolidation; children may still get read-only recall. Otherwise duplicate memory writes per background retry.

## 12. Production notes / limits

- **Startup:** extension factory runs on every pi invocation (including `pi --help`-ish paths that load extensions?). Docs: "factories may run in invocations that never start a session. Do not start background resources … from the factory." Async factory is awaited before `session_start` → keep it fast (<50-100 ms); defer heavy I/O to `session_start` or lazy init.
- **Single thread:** all handlers share the event loop; `before_agent_start` handlers are awaited before the LLM call — keep them <10-20 ms (snapshot cache hit), never network.
- **Shutdown:** `session_shutdown` is awaited without timeout; self-bound any LLM work (pi-memory races a timeout). Also `reason` is not always "quit" — skip expensive work for `reload|new|resume|fork`.
- **Compaction:** `session_before_compact` gives `preparation`, `branchEntries`, `reason`, `willRetry`, `signal`; returning `{compaction}` replaces pi's summary (pi-memory appends a handoff block). The compaction boundary changes what `buildContextEntries()` returns — refresh memory snapshot after.
- **Sizes:** no documented cap on injected system-prompt text; practical budget: keep hot index ~1-3 KB, recall tool results bounded (pi's own truncation helpers exist for tool outputs; see `read.ts` `ReadToolDetails`). Message/tool result size limits [unverified].
- **Logging:** write JSONL to `~/.pi/agent/harnmem/logs/…`, rotate; never block hooks on sync fs writes (append with a small queue).
- **File watching:** allowed but must start in `session_start`, stop in `session_shutdown`; prefer lazy mtime check (pi-memory does an update timer + snapshotDirty flag).
- **Ordering:** no documented extension priority mechanism [unverified]; use `pi.events` EventBus for coordination, and make injections additive/chained.

## 13. Probe (`spikes/pi-probe`)

Files: `package.json` (`pi.extensions:["./index.ts"]`, keyword `pi-package`, peerDeps: pi-ai/pi-coding-agent/typebox), `index.ts` (registers 1 tool `probe_memory`, events `session_start`, `before_agent_start`, `before_provider_request`, `turn_end`, command `probe-status`, appends log lines to `probe.log`).

Run:
```
pi -p --no-session -e "<repo>\spikes\pi-probe\index.ts" "Reply with exactly: PROBE_DONE"
```
Result: exit 0, stdout `PROBE_DONE`; `probe.log`:
```
factory loaded (cwd=…, …)                 ← module imported by jiti
factory done: 1 tool + 3 events + 1 command registered
event session_start reason=startup cwd=<workdir> sessionId=<session-id> file=ephemeral entries=2
event before_agent_start systemPromptLen=27735 model=<model>
event before_provider_request payloadLen=165271 hasMarker=true   ← injected text reached the real provider payload
event turn_end stopReason=stop
```
Proved: `-e` loading of a bare `.ts` (jiti), tool+command registration, session event with a readable session manager, and `before_agent_start` system-prompt injection surviving into the provider request. `turn_end` fired in print mode too (`stopReason=stop`). Note: only 2 entries at session_start (header+initial state) — transcript grows later.

---

## 14. CAPABILITY MATRIX — harnmem needs → pi APIs

| Need | pi API | Skeleton |
|---|---|---|
| Inject hot memory index at session start | `before_agent_start` → `{systemPrompt}` + snapshot cache | `on("session_start", () => loadAndSnapshot()); on("before_agent_start", (e) => ({ systemPrompt: e.systemPrompt + "\n" + cachedBlock }))` — byte-stable bytes |
| Per-turn passive recall | `input` (prompt text, pre-turn) / `before_agent_start` `event.prompt`; async `context` event to insert msgs if needed | `on("before_agent_start", async (e) => { prefetch(e.prompt) /* fire-and-forget */ })` |
| memory_write / search / status tools | `pi.registerTool` (TypeBox), `tool_call` guard, `tool_result` patch | `registerTool({name:"harnmem_write", parameters: Type.Object({...}), async execute(id,p,sig,upd,ctx){...}})` |
| Background extraction at session end / turn end | `session_shutdown` (+ self-timeout), `turn_end`/`agent_settled`, `complete()` | `on("session_shutdown", async (e, ctx) => { if (e.reason!=="quit") return; await Promise.race([summarize(ctx), timeout(8s)]) })` |
| Session id + cwd + transcript | `ctx.sessionManager.getSessionId/getSessionFile/getCwd/buildContextEntries`, `ctx.cwd` | `const sid = sm.getSessionId(); const msgs = sm.buildContextEntries()` |
| Call model for extraction | `complete(model, {systemPrompt,messages}, {apiKey, reasoningEffort:"low"})`; api key from `ctx.modelRegistry.getApiKey(ctx.model)` | see §6 |
| Store config | `registerFlag`/`getFlag`; `getAgentDir()+"/harnmem.json"`; project `.pi/harnmem.json` + `isProjectTrusted()` | `readJson(join(getAgentDir(), "harnmem.json"))` |
| Status UI | `ctx.ui.setStatus("harnmem", …)` / `setWidget` / `notify`; guard `hasUI` | `if (ctx.hasUI) ctx.ui.setStatus("harnmem", `🧠 ${n} idx`)` |
| Slash commands | `registerCommand("memory", {description, handler})` | `/memory status|search <q>|on|off` |
| Pre-compaction handoff | `session_before_compact` → `{compaction:{summary, firstKeptEntryId, tokensBefore}}` or side-file capture | capture open items; refresh snapshot afterwards |
| Persist non-context state | `pi.appendEntry(customType, data)` + `registerEntryRenderer` | durable TUI-only notes |
| Subagent safety | detect child session (pi-subagents ambient inheritance in background children) | dedupe by session id; children read-only |
| Inter-plugin coordination | `pi.events: EventBus` (emit/on) | e.g. tell other extensions index changed |

### Minimal plugin skeleton (pi package)
```ts
// extensions/harnmem.ts
import { join } from "node:path";
import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";

let snapshot = "";
let dirty = true;

export default function harnmem(pi: ExtensionAPI) {
  pi.on("session_start", async (_e, ctx) => { snapshot = await buildHotIndex(ctx.cwd); dirty = false; });
  pi.on("before_agent_start", async (e, ctx) => {
    if (dirty) { snapshot = await buildHotIndex(ctx.cwd); dirty = false; }
    return snapshot ? { systemPrompt: `${e.systemPrompt}\n\n## HarnMem memory\n${snapshot}` } : undefined;
  });
  pi.on("turn_end", () => { /* cheap append to journal; debounce */ });
  pi.on("session_before_compact", async (_e, ctx) => { /* capture handoff to disk */ });
  pi.on("session_shutdown", async (e, ctx) => {
    if (e.reason !== "quit") return;
    const model = ctx.model; if (!model) return;
    const apiKey = await ctx.modelRegistry.getApiKey(model);
    await Promise.race([extractAndStore(ctx, model, apiKey), new Promise(r => setTimeout(r, 8000))]);
  });
  pi.registerTool({ name: "harnmem_write", label: "HarnMem Write", description: "Persist a durable memory",
    parameters: Type.Object({ text: Type.String(), tags: Type.Optional(Type.Array(Type.String())) }),
    async execute(_id, p) { await writeMemory(p); dirty = true; return { content: [{ type: "text", text: "stored" }], details: {} }; } });
  pi.registerCommand("memory", { description: "HarnMem memory status",
    handler: async (_a, ctx) => { if (ctx.hasUI) ctx.ui.notify(`harnmem: ${snapshot.length} chars`, "info"); } });
}
```

## 15. Open questions / unverified

- Extension load order & conflict precedence across global/project/package (`pi config` ordering): not documented [unverified].
- `sendMessage`/tool-result size caps, and whether custom messages count against context budget automatically: not documented [unverified].
- Any official debug/tracing env flag (`PI_DEBUG`?) and extension logging convention: not documented [unverified].
- `complete()` AbortSignal/`signal` option and structured timeouts in pi-ai v1.3.0: not confirmed in local typings [unverified].
- How to reliably detect a pi-subagents child session from inside an extension (env var or session header marker): not confirmed; recommend checking session id/header + `PI_SUBAGENTS_*` env empirically [unverified].
- Whether background-child ambient extensions receive `session_shutdown` on child end (for dedupe design): implied by fraction of docs, not verified [unverified].
