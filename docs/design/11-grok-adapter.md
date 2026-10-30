# 11 · Grok adapter: memory index through MCP `initialize.instructions`

Status: implemented as `packages/grok-harnmem` (0.1.0), verified against Grok CLI
1.0.70 on Windows. Research and probe evidence:
[`research/grok-plugin.md`](../research/grok-plugin.md).

## 1. Constraints and design goals

Grok is a Rust terminal agent with a Claude Code compatibility layer. It reads
Claude-shaped plugins (`skills/`, `commands/`, `agents/`, `hooks/hooks.json`,
`.mcp.json`) and it auto-loads installed Claude plugins, but three of its hook
semantics make the Claude Code adapter's injection path unusable:

- **`SessionStart` is observe-only.** `hookSpecificOutput.additionalContext` and
  plain stdout are read and discarded; only a top-level `systemMessage` is
  consumed, and that reaches the client UI (an entry in `updates.jsonl` with
  `sessionUpdate: "hook_annotation"`), not the model's context.
- **The system prompt is rendered before `SessionStart` hooks run** (measured
  gap on 1.0.70: the prompt snapshot lands ~260 ms before the hook starts), so
  nothing a `SessionStart` hook writes can influence the same session.
- **`UserPromptSubmit` has no stdout channel either**: an allowing hook's stdout
  is discarded, and there is no `additionalContext` for that event.

The adapter therefore must inject the memory index through a surface Grok reads
**before the first turn** and that is model-visible. The only such surface with
verified behavior is the MCP handshake: a server's `initialize.instructions`
string is rendered as a `<system-reminder>` titled `MCP servers connected: …`.
Goals, in priority order:

1. Inject a byte-stable hot index before the first turn (probe-verified channel).
2. Keep the injected block small enough to survive Grok's aggregate reminder
   truncation and to leave room for the user's other MCP servers.
3. Expose the canonical memory tools without changing their semantics.
4. Extract memories at session end without blocking Grok's exit.
5. Reuse the vendored `@harnmem/core` and the claude adapter's neutral glue
   (`lib/format.mjs`, `lib/engine.mjs`, `lib/settings.mjs`, `scripts/vendor.mjs`)
   instead of forking the engine.

## 2. Components and call paths

```
grok TUI / `grok -p`
 ├─ plugin load: .grok-plugin/plugin.json, hooks/hooks.json, .mcp.json, commands/, skills/
 ├─ MCP server (node mcp/mcp.mjs, stdio):
 │    initialize → engine.sessionStart() → capInstructText(maxInstructBytes) → { instructions }
 │    tools/call  → memory_search/read/write/forget/status/context
 └─ SessionEnd hook (node hooks/hook.mjs):
      payload → tmp payload file → detached child (or inline when HARNMEM_EXTRACT_SYNC=1)
      → read chat_history.jsonl (fallback updates.jsonl) → engine.sessionEnd()
```

Files:

| Path | Role |
| ---- | ---- |
| `.grok-plugin/plugin.json` | native Grok manifest (name `grok-harnmem`, version, metadata) |
| `.claude-plugin/plugin.json` | Claude-compatible manifest so the same package loads there too |
| `.mcp.json` | stdio server wiring, `${GROK_PLUGIN_ROOT}/mcp/mcp.mjs` |
| `hooks/hooks.json` | `SessionEnd` only — no `SessionStart` (it cannot work) |
| `mcp/mcp.mjs` | JSON-RPC 2.0 server; six tools; `initialize.instructions` builder |
| `hooks/hook.mjs` | `SessionEnd` handler; detached extract worker; transcript discovery |
| `lib/engine.mjs` | `openEngine({harness: "grok"})` over `vendor/core` |
| `lib/settings.mjs` | config/env resolution incl. `maxInstructBytes` |
| `lib/transcript.mjs` | `chat_history.jsonl` / `updates.jsonl` parsers |
| `lib/format.mjs` | tool-result formatting (shared with the claude adapter) |
| `commands/memory.md` | `/harnmem:memory` operator command |
| `skills/harnmem-recall/SKILL.md` | pull-style recall guidance for the model |

## 3. Injection channel: `initialize.instructions`

### 3.1 What Grok does with instructions

When the plugin's stdio server completes the MCP handshake, Grok appends the
server to the session's "MCP servers connected" reminder. A server with
`instructions` contributes `- <server> (<n> tools): <instructions>`. The reminder
is a synthetic user message (`<system-reminder>…</system-reminder>`, with a
`synthetic_reason` in `chat_history.jsonl`) and it is re-sent on later model
calls in the same session.

### 3.2 Truncation budget

Grok caps the aggregate reminder. Probe measurement: a 6,042-character
`instructions` string from one server, plus a second server, produced a
4,293-character reminder ending in `…[truncated]` (the tail markers were cut and
the model saw the literal `[truncated]`). Consequences:

- One server cannot assume a per-server budget; the cap is aggregate, so the
  adapter defaults to **2,500 bytes** (`HARNMEM_GROK_MAX_INSTRUCT_BYTES`).
- The adapter truncates deterministically at a **complete line boundary**
  (UTF-8 code-point safe), never mid-multibyte and never mid-memory, and appends
  a fixed pointer: `… (memory index truncated; call memory_context for the full
  snapshot)`.
- The truncation error is inherent to the channel, so the full snapshot is always
  reachable with the sixth tool, `memory_context`. A skill also tells the model
  when to pull it.

### 3.3 Byte stability

`buildInstructions()` runs once per process, at `initialize`, through
`engine.sessionStart({ reason: "session_start" })`, then caps the text. Nothing
in the injected string contains wall-clock time, counters or random ordering, so:

- the same store and the same day yield the **same bytes** on every restart;
- within a session the reminder is re-sent unchanged → prompt prefix stays
  cache-stable (adapter contract §4.3, Option P);
- an empty store injects **no `instructions` key at all** (zero bytes rather than
  a "no memories" placeholder).

`memory_context` deliberately bypasses the cap by calling
`engine.ensureContext("manual")`, the same snapshot core returns for a manual
refresh; it is an explicit model action, not background churn.

### 3.4 Other channels considered and rejected

| Channel | Verdict |
| ------- | ------- |
| `SessionStart` `additionalContext` | dropped by Grok — probe-verified |
| `SessionStart` `systemMessage` | client annotation only — never model-visible |
| `<GROK_HOME>/rules/*.md` written by the hook | system prompt is built before hooks, and the probe could not get home rules to load at all; unresolved in 1.0.70 |
| `--rules` / `_meta.rules` launch flag | works for user-supplied rules, but a plugin cannot add launch flags to the user's command line |
| Grok native memory (`memory_v2`) | separate store and lifecycle; conflicts with the cross-harness SSOT |
| `PreToolUse` `additionalContext` | works, but only after a tool call — too late for turn 1 and it churns the prefix on every call |
| `Stop` `decision:block` | works as a gate, wrong tool for a static index |

## 4. Hook mapping

Only one hook is registered:

```json
{ "hooks": { "SessionEnd": [ { "hooks": [
  { "type": "command", "command": "node \"${GROK_PLUGIN_ROOT}/hooks/hook.mjs\"", "timeout": 10 }
] } ] } }
```

Why `SessionEnd` only:

- There is no model-visible `SessionStart` output in Grok 1.0.70 (§3.4).
- Grok's `SessionEnd` is observe-only and its stdout is ignored, which is exactly
  what the extract worker needs: no protocol, no output, just side effects.
- Grok caps a plugin's `SessionEnd` hook at the default 1.5 s budget regardless of
  the configured `timeout`, so the hook does the minimum (write the payload,
  spawn a detached child) and the child does the work. `hooks/hook.mjs` always
  exits 0 so a failure can never wedge the session.
- The payload's `transcript_path` alias points at the session's
  `updates.jsonl`, not at a Claude-style transcript; the hook resolves the
  session directory from it (or scans `$GROK_HOME/sessions/*/<sessionId>`), then
  prefers `chat_history.jsonl`.

### 4.1 Input fields used

`SessionEnd` payload (camelCase with snake_case aliases):

| Field | Use |
| ----- | --- |
| `sessionId` / `session_id` | engine session id and session-directory fallback |
| `cwd`, `workspaceRoot` | project detection |
| `transcriptPath` / `transcript_path` | `updates.jsonl` → parent dir = session dir |
| `subagentType` | subagent sessions are read-only and never journal |
| `reason` | forwarded to `engine.sessionEnd({ reason })` |
| `hook_event_name` | event dispatch (`hookEventName` is the camelCase value, e.g. `session_end`) |

### 4.2 Transcript discovery and parsing

`readSessionMessages()` tries `chat_history.jsonl` first, then `updates.jsonl`:

- `chat_history.jsonl` is the raw chat history sent to the model. Each line has
  `type: system | user | assistant | reasoning`; real user turns carry a numeric
  `prompt_index`, machine-injected reminders carry `synthetic_reason`, and
  `content` is a string (system/assistant) or an array of `{type: "text"}` blocks.
  Parser: keep user turns with `prompt_index` (fallback: non-synthetic users),
  keep all assistant turns, drop system/reasoning/synthetic reminders.
- `updates.jsonl` is the ACP update stream (`method: "session/update"` or
  `"_x.ai/session/update"`), chunk-oriented: `user_message_chunk` and
  `agent_message_chunk` records with `content` as a single `{type:"text"}` block.
  Parser: concatenate chunks per role, flush on role change, ignore
  `agent_thought_chunk` and tool records.

Both parsers are tolerant (malformed lines skipped, never thrown) and capped at
400 messages × 4,000 characters, matching the claude adapter's extraction
budget.

## 5. Injected content and cache strategy

The injected text is exactly the core `ContextBlock.text` — pinned entries,
high-value entries, recent entries and digest lines within core's token budget —
plus the truncation pointer when the byte cap clipped it. The adapter adds no
header of its own beyond what core emits, so the message is identical to what the
Claude adapter would send in the same store state (up to core's harness label).

No timestamps, session ids, counters or per-turn state enter the text. On a
`memory_write` during the session, core marks its snapshot dirty and the next
`memory_context` (or next process start) rebuilds; the MCP `instructions` block
itself is fixed for the process lifetime, which is the cache-friendly choice.

## 6. Configuration and priority

Reuses the claude adapter's resolution order:

1. environment, 2. `~/.harnmem/config.json`, 3. `<project>/.harnmem.json`,
4. defaults.

Grok-specific keys:

| Env | Default | Meaning |
| --- | ------- | ------- |
| `HARNMEM_GROK_MAX_INSTRUCT_BYTES` | `2500` | byte cap for `initialize.instructions` |
| `HARNMEM_GROK_MAX_INJECT_TOKENS` | `1200` | core retrieval budget for the snapshot |
| `GROK_HOME` | `~/.grok` | session-directory discovery and payload fallback |
| `HARNMEM_HOME`, `HARNMEM_DISABLED`, `HARNMEM_READONLY`, `HARNMEM_DEBUG`, `HARNMEM_AUTO_EXTRACT`, `HARNMEM_INJECT` | shared | same semantics as every other adapter |

Config-file values are validated and coerced (strings to booleans, numbers to
positive integers); malformed values fall back to defaults rather than disabling
the adapter. Extraction stays opt-in (`autoExtract: false`); the transcript is
journaled regardless, and without a configured `llm` core records
`status: no_llm` in the audit log.

## 7. Installation and packaging

- The repo root is a Grok marketplace: `.grok-plugin/marketplace.json` with one
  plugin entry, `source: { "source": "local", "path": "./packages/grok-harnmem" }`.
- The plugin declares the id `harnmem` — deliberately the same id as the Claude
  Code adapter — so Grok's same-name precedence shadows a `claude-harnmem` copy
  that Grok auto-discovers from `~/.claude/plugins/` (verified, see §7.1). The
  package/npm name stays `grok-harnmem`.
- `grok plugin install harnmem --trust` (after
  `grok plugin marketplace add <checkout>`) copies the package into
  `$GROK_HOME/installed-plugins/<id>/` and enables it. Grok does not load a
  plugin's components until it is trusted; `~/.grok/plugins/` is trusted
  automatically. If more than one registered marketplace offers `harnmem` (a
  Claude Code marketplace is auto-imported), pin the source with
  `grok plugin install harnmem@<marketplace-name> --trust`; a direct package-path
  install is always unambiguous.
- `@harnmem/core` is vendored into `vendor/core/` at build time (core dist plus
  its `prompts/` and `data/` assets), so the installed directory is
  self-contained and the runtime has zero dependencies.
- JSON files must be **BOM-less**: Grok silently skips a `plugin.json` or
  `hooks.json` that starts with a UTF-8 BOM, and Windows PowerShell 5.1 writes
  one by default. Tests assert BOM-free JSON.
- Hook commands use the string form (`node "${GROK_PLUGIN_ROOT}/hooks/hook.mjs"`)
  because Grok's runner executes string commands through the shell; the
  `command` + `args` form is not needed and was not probed to the same depth.

### 7.1 Coexistence with claude-harnmem

Grok auto-discovers Claude Code plugins from `~/.claude/plugins/`, independent of
the `[compat.claude]` cells (those gate skills/rules/agents/MCP config/hooks, not
plugin bundles). With both adapters installed, both plugins were discovered and
enabled, both provided an MCP server named `harnmem`, and both registered a
`SessionEnd` hook. Probe results on 1.0.70:

- Grok registers exactly one MCP server per name; the Claude-discovered server
  won the name, so the 6-tool server with `initialize.instructions` and
  `memory_context` was silently replaced by the 5-tool Claude server.
- `hooks.dispatch{hook_event=session_end hook_count=2}` — both extractors ran.
- Controls that did **not** work: `[plugins] disabled = ["harnmem"]` in
  `~/.grok/config.toml` left the Claude copy enabled and did not change MCP
  resolution; `grok plugin disable harnmem` returns "Plugin \"harnmem\" not
  found" because the Claude copy is not in Grok's plugin list; Claude's own
  `enabledPlugins: false` is ignored by Grok's discovery.

The fix is the shared plugin id: with the manifest renamed to `harnmem`,
Grok's documented precedence ("when two plugins share a name the higher-priority
one wins") kept only the native Grok install. `grok inspect --json` then showed
one `harnmem` plugin under `<GROK_HOME>/installed-plugins/`, one MCP server from
that path, and `hook_count=1`; a headless session registered all six
`harnmem__*` tools. Users keep `claude-harnmem` for Claude Code and need no
disable step for Grok. If the native plugin is disabled, Grok falls back to the
Claude-discovered copy (5 tools, no index injection) — documented, not
recommended.

### 7.2 Sandboxed stores

Sandbox profiles are enforced on Linux (Landlock) and macOS (Seatbelt); the
Windows CLI has no kernel sandbox (a `--sandbox read-only` run on Windows
1.0.70 showed no enforcement in the logs). On Linux/macOS `workspace` allows
writes to `~/.grok` and the working directory but not `~/.harnmem`;
`read-only` and `strict` make the store read-only, so memory tools degrade to
read errors while injection/search still work. Add the store to a custom profile
in `~/.grok/sandbox.toml` or `.grok/sandbox.toml` (paths are literal and
absolute; `~` is not expanded) and select it with `grok --sandbox harnmem` or
`[sandbox] profile = "harnmem"`:

```toml
[profiles.harnmem]
extends = "workspace"
read_write = ["/home/<user>/.harnmem"]   # macOS: /Users/<user>/.harnmem
```

If `HARNMEM_HOME` is set, list that path instead. Pointing `HARNMEM_HOME` inside
the workspace keeps tools writable but yields a store other harnesses cannot
see; `HARNMEM_READONLY=1` is the explicit read-only degrade for shared stores.

## 8. Degradation matrix

| Failure | Behavior |
| ------- | -------- |
| MCP server fails to start | Grok reports it in `/mcp`; the session continues without memory tools; no hook failure |
| `initialize.instructions` empty (empty store, `HARNMEM_DISABLED=1`, `inject: false`) | no `instructions` key at all |
| Aggregate reminder truncation | injected text is pre-truncated at a line boundary with the `memory_context` pointer |
| Store read-only (sandbox, permissions) | tools return readable errors; injection still works |
| `SessionEnd` hook cannot spawn the worker | hook exits 0; no journal, no extraction; nothing blocks exit |
| Missing transcript (daemon route has no `transcript_path`) | session-directory scan; if nothing is found the worker exits without journaling |
| No `llm` configured | transcript journaled, extraction status `no_llm` |
| Core `SCHEMA_NEWER` | engine reopens read-only (shared failure mode) |

## 9. Security and privacy

The store is local Markdown under `~/.harnmem/`; the adapter never opens a
network connection. The MCP server writes nothing to stdout outside JSON-RPC, and
hook scripts print nothing. Nothing from a transcript is written to the store
unless extraction is enabled and an LLM is configured by the user. The plugin
never reads or writes `~/.grok/sessions` beyond the session directory named by
the `SessionEnd` payload, and never commits or copies memory content into the
repository.

## 10. Acceptance checklist

- [x] `grok plugin validate packages/grok-harnmem` passes.
- [x] `grok plugin install harnmem --trust` (and a direct package-path install)
      copies and enables it as `harnmem`.
- [x] Headless `grok -p` with a seeded store: the injected index appears in
      `chat_history.jsonl` and the model can repeat it.
- [x] Six MCP tools registered; `memory_read` / `memory_write` round-trip through
      Grok (`use_tool`), writes land with `source.harness="grok"`.
- [x] `SessionEnd` journals the transcript exactly once; subagent sessions do not.
- [x] Empty store injects zero bytes; a `HARNMEM_DISABLED=1` store is inert.
- [x] 31 adapter tests green (`node --test packages/grok-harnmem/test/*.test.mjs`).
- [x] Real `~/.grok` and `~/.harnmem` untouched during tests (isolated `GROK_HOME`
      and `HARNMEM_HOME`).
- [x] Package is installable from the repo root marketplace.
- [x] Coexistence with an auto-loaded `claude-harnmem` resolved by the shared
      plugin id: with the manifest named `harnmem`, Grok kept only the native
      install (one plugin, one MCP server with six tools, `hook_count=1`); see
      §7.1. The previous "disable one plugin" recipe no longer applies.
- [x] Sandbox guidance documented for Linux/macOS (custom profile `read_write`)
      and Windows (no kernel sandbox); see §7.2.

## 11. Unverified items and risks

1. **Aggregate reminder cap priority.** The exact rule (per-server vs aggregate,
   and which server loses bytes when several declare `instructions`) is not
   documented; the measured 4,293-character aggregate is the basis for the
   2,500-byte default. Users with many MCP servers should lower it further.
2. **TUI vs headless parity.** Verification used `grok -p`; the TUI uses the same
   MCP and hook machinery, but `/plugins` trust interactions and status rows were
   not exercised end to end.
3. **Daemon route transcripts.** On the daemon route Grok sends no
   `transcript_path`; directory scanning by session id is the fallback and was
   covered by unit tests, not by a live daemon run.
4. **Duplicate hook command dedupe (resolved by the shared plugin id).** During
   early probing, two plugins declaring the same SessionEnd command string
   (`node "${CLAUDE_PLUGIN_ROOT}/hooks/hook.mjs"`) produced only one dispatch;
   that observation is no longer load-bearing. The plugin now declares the id
   `harnmem`, so a `claude-harnmem` copy auto-loaded by Grok is shadowed and only
   one `SessionEnd` hook exists (§7.1).
5. **Sandboxed store.** Grok's `read-only`/`strict` profiles leave `~/.harnmem`
   read-only on Linux/macOS; the adapter degrades to read errors and never
   relocates the store. The recommended custom profile is in §7.2. Windows has no
   kernel sandbox, so the Windows CLI is unaffected.
6. **Native memory overlap.** Grok's own `memory_v2` feature stores memories in
   `~/.grok/memory-v2/`; the two systems do not share state. Keep native memory
   disabled for a single source of truth.

## 12. References

- Grok plugin/hook/session docs (1.0.70): `09-plugins.md`, `10-hooks.md`,
  `12-project-rules.md`, `13-memory.md`, `15-agent-mode.md`, `17-sessions.md`,
  `25-status-line.md`, `26-config-reference.md`.
- Probe record and command log: [`research/grok-plugin.md`](../research/grok-plugin.md).
- Adapter contract: [`07-adapter-contract.md`](./07-adapter-contract.md).
- Claude adapter (shape reused): [`09-claude-adapter.md`](./09-claude-adapter.md).

## 13. Differences from the claude adapter (design evolution record)

| Dimension | `claude-harnmem` | `grok-harnmem` |
| --------- | ---------------- | -------------- |
| Injection | `SessionStart` `additionalContext` | MCP `initialize.instructions` (+ `memory_context` pull) |
| Injected cap | 10,000 chars (Claude's harness cap) | 2,500 bytes by default, configurable |
| Hooks | `SessionStart` + `SessionEnd` | `SessionEnd` only |
| Tool count | 5 | 6 (`memory_context`) |
| Transcript | `transcript_path` (Claude JSONL) | `chat_history.jsonl`, fallback `updates.jsonl` |
| Plugin id | `harnmem` | `harnmem` (same id on purpose: shadows an auto-loaded `claude-harnmem`) |
| Command | `/harnmem:memory` | `/harnmem:memory` (namespaced by the shared plugin id) |
| Manifest | `.claude-plugin/plugin.json` | both `.grok-plugin/` and `.claude-plugin/` |
| Marketplace | root `.claude-plugin/marketplace.json` | root `.grok-plugin/marketplace.json` |
