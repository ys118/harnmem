# 12 Cursor adapter: user-level hooks + plugin rules/MCP

> Cursor exposes three extension points that matter here: **hooks** (process-level
> event callbacks configured in `hooks.json`), an **MCP server** (stdio tools), and
> **rules** (always-on context files). This adapter = `packages/cursor-harnmem`, a
> zero-dependency package that reuses the vendored `@harnmem/core` facade; no
> tokenizer, model, database or network is introduced.
>
> Evidence levels used below: **[V] verified first-hand** on Cursor desktop
> 3.27.22 / Windows 11 on 2026-10-30 (probe tokens recalled by the model, hook
> payloads captured to disk, Cursor workbench source inspected; see
> [research/cursor-plugin.md](../research/cursor-plugin.md) §10), **[D] designed**
> (derived from [V] facts plus this implementation), **[U] unverified** (no way to
> observe it yet; listed in §11).

> **STATUS (2026-10-30): IMPLEMENTED** as `packages/cursor-harnmem`. Deviations from
> the original research proposal, all forced by first-hand evidence:
>
> 1. **Injection runs on `beforeSubmitPrompt`, not `sessionStart`.** The published
>    schema for `beforeSubmitPrompt` lists only `continue`/`user_message`, but on
>    3.27.22 a flat `additional_context` on its stdout JSON reaches the model as a
>    system reminder on **every** turn [V, token-recall experiment v4].
>    `sessionStart` does fire for new conversations, but its `additional_context`
>    is still dropped on 3.27.22 [V, experiment v3] — the long-standing ordering
>    bug was never fixed for the desktop IDE.
> 2. **The adapter injects once per conversation, not once per turn.** A marker
>    keyed by `conversation_id` (fallback `session_id`) keeps the injected
>    snapshot byte-stable and later prompts cost no engine boot. The marker is
>    `pending` until `afterAgentResponse` confirms that a model response was
>    produced; a first turn that failed before the model ran (observed live:
>    `Model unavailable on Free`) therefore re-injects on retry, while confirmed
>    conversations stay silent. This is the strongest form of the KV-cache rule
>    from [07](07-adapter-contract.md) §4.3 Option P.
> 3. **Hooks are installed into the user-level `~/.cursor/hooks.json`, not shipped
>    inside the plugin only.** The user-level file is the documented, hot-reloaded
>    source [V]. A plugin directory does *also* contribute hooks on 3.27.22 when
>    the manifest declares `hooks/hooks.json`: the hook log then shows a second
>    invocation tagged `from claude-plugin config`, executed with the plugin root
>    as cwd [V, final acceptance run — `Found 2 hook(s) to execute for step:
>    beforeSubmitPrompt`, commands differing only by path separators]. That path
>    is still gated behind `enable_cc_plugin_import` plus the global Claude-hooks
>    setting and was *not* active during the earlier reload-only probes, so it is
>    a bonus, not a dependency. Both entry points therefore run the same script
>    and the adapter deduplicates them with exclusive claim files (§4.1); the
>    installer writes the authoritative `~/.cursor/hooks.json` entries
>    (read-merge-write, idempotent, never clobbers foreign entries).
> 4. **Extraction uses `sessionEnd` + a detached child process**, mirroring the
>    Claude adapter: Cursor's `sessionEnd` is fire-and-forget and receives
>    `transcript_path`, `reason`, `final_status` and `is_background_agent` [V].
> 5. **`rules/harnmem.mdc` is the documented fallback.** A plugin rule with
>    `alwaysApply: true` is discovered and injected in the same session it is
>    installed [V], so a user whose hooks were not installed (or were broken by a
>    Cursor update) still gets the "HarnMem exists, use the tools" guidance.
> 6. **MCP is registered through the plugin `mcp.json`** (`plugin-harnmem-harnmem`
>    server, `${CURSOR_PLUGIN_ROOT}` expanded [V]); `scripts/install.mjs --mcp-user`
>    additionally merges a `harnmem` server into `~/.cursor/mcp.json` for setups
>    where the plugin directory is not loaded.

## 1. Constraints and design goals

| Constraint | Design choice |
|---|---|
| Zero external services / offline | Hook and MCP entries are local `node` processes that only read/write `~/.harnmem/`; no network, no model |
| Injection must not depend on plugins | Injection goes through a user-level hook; plugins only carry rules + MCP (the two things the IDE provably loads from a local plugin [V]) |
| Project-level configuration is unreliable | Project `.cursor/mcp.json` is not wired into the agent for this version [V] and project `.cursor/hooks.json` requires a trusted workspace and is hot-reloaded from the project root; the adapter never depends on either |
| KV-cache stability | Exactly one injection per conversation, byte-identical for identical store state; 10,000-byte deterministic cap with a visible truncation marker |
| Write discipline | With no model on the Cursor side, no automatic extraction (`llm=null`); only explicit model calls to `memory_write` remain |
| Share data with pi/DSH/Claude/Codex | Only calls the `HarnMem` facade; `source.harness="cursor"`; same projectId/scope/audit |
| Fail open | Any hook failure prints nothing (or an empty JSON object) and exits 0; a broken hook must never block a prompt or a window close |

## 2. Components and call paths

```
Cursor desktop (IDE agent)
  |- hooks (user-level ~/.cursor/hooks.json, installed by scripts/install.mjs)
  |   |- node "<plugin>/hooks/hook.mjs" beforeSubmitPrompt
  |   |    stdin: hook JSON -> stdout: {"additional_context":"..."} (first turn only)
  |   |    solve: marker check -> HarnMem.open -> sessionStart -> capBytes(10k)
  |   `- node "<plugin>/hooks/hook.mjs" sessionEnd
  |         stdin: hook JSON (has transcript_path) -> persist payload -> spawn detached
  |              `- --extract-phase: parseCursorTranscript -> HarnMem.sessionEnd(messages)
  |- plugin: .cursor-plugin/plugin.json
  |   |- rules/harnmem.mdc        (alwaysApply: true; fallback guidance)
  |   |- mcp.json -> plugin-harnmem-harnmem -> node "<plugin>/mcp/mcp.mjs"
  |   |    JSON-RPC 2.0 over stdio: memory_search/read/write/forget/status
  |   `- hooks/hooks.json          (forward-compatible; used if plugin hooks become ungated)
  `- storage: ~/.harnmem/ (memories/ index/ state/audit.jsonl sessions/ trash/)

Temporary state: %TMP%/harnmem-cursor/injected/<sha1>.json (conversation markers, 48 h TTL)
                 %TMP%/harnmem-cursor/session-end-*.json (extraction payloads, 1 h TTL)
```

- Both hook entry points share the same vendored core, config resolution and
  project detection; the hook process starts in roughly 30-40 ms (Node ESM +
  core's dist).
- The hook never writes to stdout except for the single JSON payload it is
  supposed to return; diagnostics go to stderr only when `HARNMEM_DEBUG=1`.

## 3. Transport layer: plugin MCP server

### 3.1 Package shape

```jsonc
// packages/cursor-harnmem/package.json
{
  "name": "cursor-harnmem",
  "type": "module",
  "files": [".cursor-plugin/", "mcp.json", "hooks/", "mcp/", "rules/", "commands/",
            "lib/", "vendor/", "scripts/", "README.md", "LICENSE"],
  "scripts": { "build": "node scripts/vendor.mjs", "test": "node --test test/*.test.mjs" },
  "devDependencies": { "@harnmem/core": "workspace:*" },
  "engines": { "node": ">=22.15" }
}
```

- The MCP server is the same zero-dependency `mcp/mcp.mjs` as the Claude adapter
  (JSON-RPC 2.0, newline-delimited, `protocolVersion 2024-11-05`); only the log
  prefix and comments are adapter-specific. `initialize` opens
  `HarnMem.open({harness:"cursor"})`; stdin EOF -> `close()`.
- Tool names are unprefixed in the registry (`memory_search`, …); Cursor exposes
  the plugin server as `plugin-harnmem-harnmem` [V] and the agent sees the five
  tool namespaces in its catalog.
- `@harnmem/core` is vendored into `vendor/core/` at build time, so the installed
  plugin directory is self-contained and works without `pnpm`/`npm` (the same
  `scripts/vendor.mjs` as the Claude adapter).

## 4. Injection layer

### 4.1 Hook registration (user level)

`scripts/install.mjs` copies the package to `<cursorHome>/plugins/local/harnmem`
and merges this into `<cursorHome>/hooks.json` (default `~/.cursor/hooks.json`),
preserving foreign entries and backing up the previous file:

```jsonc
{
  "version": 1,
  "hooks": {
    "beforeSubmitPrompt": [
      { "command": "node \"<plugin>/hooks/hook.mjs\" beforeSubmitPrompt", "timeout": 20, "failClosed": false }
    ],
    "afterAgentResponse": [
      { "command": "node \"<plugin>/hooks/hook.mjs\" afterAgentResponse", "timeout": 10, "failClosed": false }
    ],
    "sessionEnd": [
      { "command": "node \"<plugin>/hooks/hook.mjs\" sessionEnd", "timeout": 10, "failClosed": false }
    ]
  }
}
```

- Cursor hot-reloads user hooks on save [V]; the installer still asks for
  `Developer: Reload Window` so the new plugin directory (rules + MCP) is
  discovered, then points at Customize -> Hooks for verification.
- **Duplicate invocations are expected, not an error.** When Cursor has also
  imported the plugin manifest, one event reaches the script twice (user config +
  `claude-plugin config` [V]). The hook takes an exclusive claim file before doing
  any work: `injected/<sha1>.json` for `beforeSubmitPrompt` (created with
  `wx`, the loser exits silently) and `session-end-claim-<sha1>.json` for
  `sessionEnd` (the loser exits without journaling). Without this, the first
  prompt would boot the engine twice and the session journal would contain every
  message twice [V: 6 journal lines for 3 messages before the fix].
- All other hook sources (`enterprise`, `project`, `claude-user`, `team`) may also
  be present; Cursor merges their responses. Our entries are marked by the
  absolute plugin path so `--uninstall` can remove exactly them.
- Windows: Cursor runs command hooks through PowerShell and pipes the payload as
  JSON on stdin; the command string quotes the path and uses `node` from PATH
  [V]. `timeout` is in seconds.

### 4.2 Injection semantics

- `beforeSubmitPrompt` fires for every user prompt with
  `{prompt, attachments, composer_mode, conversation_id, generation_id, model,
  model_id, session_id, transcript_path, hook_event_name, cursor_version,
  workspace_roots, user_email}` [V]. `transcript_path` is usually `null` at this
  point.
- The hook returns `{ "additional_context": "<snapshot>" }` on stdout. Cursor
  renders it as a system reminder before the model answers; the probe token was
  recalled verbatim by `cursor-grok-4.6-medium` [V]. This field is **not in the
  published schema** for `beforeSubmitPrompt`, so the adapter treats it as a
  version-sensitive channel: if a future Cursor ignores it, the rules file and the
  MCP tools remain functional (degradation matrix, §8).
- Only `composer_mode === "agent"` prompts are injected (ask/ask-mode and slash
  commands are skipped); a background agent (`is_background_agent: true`) is
  read-only and never writes.
- First turn of a conversation: open the engine, call
  `sessionStart({sessionId, cwd, reason:"session_start"})`, `capBytes(text)`,
  write the marker as `pending`, print the payload (nothing at all when the
  store is empty -- the 0-byte rule). When the model then answers,
  `afterAgentResponse` flips the marker to `confirmed` and later turns exit 0
  with no output and no engine boot. If the turn dies before a response (model
  unavailable, aborted), the marker stays `pending` and the next prompt retries
  the same byte-stable snapshot.
- Injection is claimed **per prompt attempt** (`conversation_id` +
  `generation_id`): duplicate hook invocations for one prompt produce exactly one
  injection, while a retry (new `generation_id`) is allowed through.
- Markers live in `%TMP%/harnmem-cursor/injected/<sha1(conversation_id)>.json`
  (`HARNMEM_CURSOR_STATE_DIR` overrides the root) with a 48 h TTL; stale markers
  and attempt claims are swept on every injection.
- `capBytes` truncates line-aligned to 10,000 UTF-8 bytes and appends
  `<!-- harnmem: snapshot truncated to fit the 10,000-character injection cap -->`;
  the same snapshot always produces the same bytes [D, unit-tested].

### 4.3 Why not `postToolUse` / `preToolUse`

Both accept `additional_context` officially (and `preToolUse` can deny a call with
an `agent_message` back to the model), but they only fire on tool calls, so they
cannot serve the "first prompt" injection; using them as a mid-session refresh
channel is possible but would break the one-injection-per-conversation cache
guarantee. Deferred; see §11 [U].

## 5. Tool layer

- Five tools with the unified names/semantics of [07](07-adapter-contract.md) §3:
  `memory_search`, `memory_read`, `memory_write`, `memory_forget`, `memory_status`
  (no `memory_restore`/`memory_consolidate` in v1, same as Claude).
- `memory_write` is the only writer (the Cursor agent has no host-side model for
  extraction); results tell the model to use `memory_search` later and never try
  to rewrite the injected system context.
- MCP tool calls surfaced as `MCP:memory_search` in `preToolUse`/`postToolUse`
  hooks [V]; tool output is returned as JSON text, capped at 12,000 characters by
  `lib/format.mjs`.
- Tools are advertised in one `tools/list` response (Cursor registers the first
  page of a paginated list only, so the adapter stays well under 25 tools).

## 6. Lifecycle layer

### 6.1 `sessionEnd`

`sessionEnd` payload [V]: `{conversation_id, generation_id, model, model_id,
session_id, reason, duration_ms, final_status, is_background_agent,
transcript_path, hook_event_name, cursor_version, workspace_roots, user_email}`.
`reason` is e.g. `user_close`; `final_status` e.g. `completed`. The event is
fire-and-forget: the hook must return immediately.

Handling, identical in shape to the Claude adapter:

1. Skip when disabled, when `is_background_agent === true`, or when
   `transcript_path` is missing.
2. Persist `{...payload, cwd}` to `%TMP%/harnmem-cursor/session-end-<id>-<ts>.json`.
3. `HARNMEM_EXTRACT_SYNC=1` -> run the extraction phase inline (deterministic test
   seam). Otherwise `spawn(process.execPath, [selfPath, "--extract-phase",
   payloadPath], {detached:true, stdio:"ignore"})` + `unref()` and `exit 0`.
4. Extraction phase: read payload -> `parseCursorTranscript(transcript_path)` -> 
   `HarnMem.open` -> `sessionEnd({sessionId, cwd, reason, messages})` -> `close()`
   -> remove the payload -> sweep stale payloads (1 h TTL).

Known Cursor quirk: the hook engine sometimes logs `MainThreadShellExec not
initialized` for plugin hooks; our hook must tolerate a missing shell context and
still exit 0 with empty stdout [V, observed on the installed Claude-format plugin].

### 6.2 Transcript parsing

- Path [V]: `<home>/.cursor/projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`
  where `<encoded-cwd>` is the absolute project path lower-cased, with the drive
  colon dropped and every `\` / `:` / space replaced by `-`
  (`D:\projects\harnmem` -> `d-projects-harnmem`); subagent transcripts sit under
  `<parent>/subagents/`.
- Lines are JSON objects; the shapes used are
  `{"role":"user","message":{"content":[{"type":"text","text":"<timestamp>...</timestamp>\n<user_query>\n...</user_query>"}]}}`,
  the same for `assistant`, and a final `{"type":"turn_ended","status":"success"}`.
  There is no `tool_use`/`tool result`/`thinking`/timestamp field in this file.
- `parseCursorTranscript` skips non-user/assistant lines, strips the
  `<timestamp>…</timestamp>` and `<user_query>…</user_query>` envelopes, keeps
  only `text` blocks, clips each message to 4,000 characters and keeps the tail
  400 messages --the same bounds as the Claude parser.
- Tool calls and results are **not** available here; extraction therefore sees the
  conversation text only. Tool-level evidence stays in the hooks log and is not
  ingested (documented in the research doc §10).

## 7. Configuration and priority

Follows [07](07-adapter-contract.md) §7; Cursor-specific environment variables:

```text
HARNMEM_HOME                      # highest priority, overrides all configuration
HARNMEM_DISABLED=1                # global disable (hooks output nothing)
HARNMEM_READONLY=1                # read-only engine (no writes, no extraction)
HARNMEM_INJECT=0                  # disable injection only
HARNMEM_AUTO_EXTRACT=1            # opt-in extraction (default off: no LLM)
HARNMEM_CURSOR_MAX_INJECT_TOKENS  # default 1200; min() with the 10,000-byte cap
HARNMEM_DEBUG=1                   # stderr diagnostics
HARNMEM_CURSOR_STATE_DIR          # internal: marker/payload root for tests
HARNMEM_CURSOR_HOME               # installer only: override ~/.cursor
```

Priority (high -> low): environment variables -> `<cwd>/.harnmem.json` -> 
`<home>/config.json` -> built-in defaults. The hook resolves the project directory
from `CURSOR_PROJECT_DIR` (or `CLAUDE_PROJECT_DIR`), then the payload's `cwd`,
then `workspace_roots` (stripping the leading `/` from `/D:/...`), then
`process.cwd()`.

## 8. Degradation matrix

| Failure | Behavior |
|---|---|
| Plugin directory not loaded (rules/MCP missing) | Hook injection still works (the hook reads core directly, no MCP dependency); the model can search only via the hook text |
| User-level hooks not installed | No injection/extraction; plugin rules explain HarnMem and the MCP tools still work (degraded, explicitly documented in README) |
| `additional_context` ignored by a future Cursor | Injection is silently lost; the rules file and MCP tools remain; audit shows injected markers being written without model-visible effect |
| `sessionEnd` fires without `transcript_path` | Extraction skipped (fire-and-forget event, nothing blocking) |
| Hook timeout / crash | Cursor discards that output; the prompt proceeds; the adapter always exits 0 and prints at most one JSON payload |
| Background agent session | Read-only: no injection (or empty), no extraction |
| Core schema newer | `SCHEMA_NEWER` -> degrade to read-only and tell the user to upgrade (same as Claude adapter) |
| No LLM on the Cursor side | `llm=null` -> no automatic extraction; explicit writes only |

## 9. Security and privacy

- Memory bodies are data, not instructions: the injected block keeps the core
  header/SSOT comment and never embeds search results; tool results carry the
  same annotation.
- Hook payloads contain PII (`user_email`) [V]; the adapter never logs, persists
  or transmits it --markers store only a hash of the conversation id, and the
  extraction payload keeps only the fields the parser needs.
- No network I/O; child processes inherit `HARNMEM_HOME` and never upload data.
- `memory_forget --hard` requires an explicit argument; the MCP server can only
  touch records inside `~/.harnmem/` by id.

## 10. Installation and packaging

```bash
# 1) inside the repo: vendor core + run the adapter's tests
pnpm --filter @harnmem/core build
pnpm --filter cursor-harnmem build
node --test packages/cursor-harnmem/test/*.test.mjs

# 2) install into the local Cursor profile (no marketplace needed)
node packages/cursor-harnmem/scripts/install.mjs            # copy plugin + merge user hooks
node packages/cursor-harnmem/scripts/install.mjs --dry-run  # show the diff first
node packages/cursor-harnmem/scripts/install.mjs --mcp-user # also merge ~/.cursor/mcp.json
node packages/cursor-harnmem/scripts/install.mjs --doctor   # self-check (exits 1 when broken)
node packages/cursor-harnmem/scripts/install.mjs --uninstall

# 3) Developer: Reload Window -> Customize -> Hooks tab to verify
```

- `--doctor` re-reads the installed plugin manifest, the three hook events, the
  MCP server declaration (plugin `mcp.json` or the `--mcp-user` fallback) and the
  Claude Code plugin registry. It exits `1` when the plugin, its hooks or its MCP
  server are missing, and it warns when `~/.claude/plugins/installed_plugins.json`
  registers another `harnmem` plugin [V, Cursor logs both `loadClaudePlugin` and
  `loadUserLocalPlugin` for this setup]. The installer runs the same pass at the
  end of a normal install.
- Cursor imports Claude Code plugins on boot
  (`thirdPartyExtensibilityEnabled`, on by default), so a `claude-harnmem`
  installed for Claude Code appears in Cursor as a second plugin named `harnmem`.
  Both copies ship an MCP server named `harnmem` (Cursor registers one) and the
  same hook script (deduped by exclusive claims, §4.1), so the duplicate is
  cosmetic; the doctor reports it instead of letting it surprise the user, and
  README documents both remedies (turn the import setting off, or uninstall the
  Claude Code copy). Unlike the Grok adapter, Cursor has no same-name precedence
  that would shadow the imported copy, so the fix is diagnostic rather than
  manifest-level.

- The installer never overwrites a user `hooks.json`/`mcp.json`: it reads,
  merges only HarnMem entries (idempotent, matched by the absolute hook-script
  path), writes a `.bak-<timestamp>` backup, then writes the merged file [D,
  unit-tested].
- Repository-level distribution: the root `.cursor-plugin/marketplace.json`
  declares the plugin (`harnmem` -> `./packages/cursor-harnmem`), so a marketplace
  install delivers the plugin (rules + MCP) in the normal way. Because plugin
  hooks are gated [V], `scripts/install.mjs` remains the documented path for the
  hook layer even after a marketplace install; README says so explicitly.
- Versioning: `cursor-harnmem` starts at **0.1.0**; it declares
  `engines.node>=22.15` and depends on `@harnmem/core` only as a dev dependency
  (vendored at build time).

## 11. Acceptance checklist

- [V] Empty store -> `beforeSubmitPrompt` prints **nothing** (0 bytes) and records
  one marker; the second prompt of the same conversation is a no-op.
- [V] A probe memory + fresh conversation -> the model recalls the injected token
  in its thinking (v4 experiment, token `S2-HMB-BBB`); the Cursor transcript shows
  the assistant answer mentioning it.
- [V] `sessionStart` output is dropped (v3 experiment, token `S1-HMP-AAA` never
  reached the model) --why the adapter does not register it.
- [V] Plugin `rules/*.mdc` with `alwaysApply` is injected (token `PLG-RULE-7`).
- [V] Plugin `mcp.json` server is registered as `plugin-harnmem-harnmem` with
  `${CURSOR_PLUGIN_ROOT}` expanded; user-level `~/.cursor/mcp.json` works too.
- [V] Local plugin `hooks/hooks.json` is **not** executed while Cursor merely
  reloads the window (probe tokens `S5-PLUG-42` / `S6-CLAUDE-77` never reached the
  model), but it *is* executed after a full Cursor restart once the manifest
  declares `hooks/hooks.json` [V, final acceptance: `from claude-plugin config`,
  plugin root as cwd]. Both entries target the same script; exclusive claims keep
  it single-shot (§4.1).
- [V] Real end-to-end install through `scripts/install.mjs` (2026-10-30, Cursor
  desktop 3.27.22, `~/.cursor` profile): a memory seeded into the real
  `~/.harnmem` store with token `HMC-ACCEPT-2026` was recalled verbatim by the
  model in its thinking on the first prompt, the model then called
  `plugin-harnmem-harnmem.memory_status` (`total=122, active=102`), and closing the
  tab produced `~/.harnmem/sessions/<date>/cursor_<conversation>.jsonl`.
- [V] Duplicate invocations (user config + plugin config) are deduplicated: unit
  tests assert exactly one injection per prompt attempt and one journal file; the
  pre-fix acceptance run journaled every message twice.
- [V] `afterAgentResponse` carries `conversation_id` plus `transcript_path`
  [V, probe event capture], which makes it a usable confirmation signal; a
  failed first turn (`Model unavailable on Free`) leaves the marker `pending`, so
  the retry re-injects [D, unit test `a retry after a failed first turn
  re-injects`; the live failure was observed in the second acceptance run].
- [D] `sessionEnd` writes a journal entry through the detached child (unit test
  with `HARNMEM_EXTRACT_SYNC=1` and a synthetic Cursor transcript).
- [D] Two turns of one conversation inject identical bytes; different
  conversations get independent markers.
- [D] Windows: `node "<path>"` quoting works through PowerShell; hooks hot-reload.
- [D] `--doctor` unit tests cover the healthy install, a missing plugin/hooks/MCP
  server, and the Claude Code duplicate warning; the installer's doctor pass runs
  in the same code path.
- [V] On the real profile `--doctor` reports the plugin (`harnmem 0.1.0`), the
  three hook events and the plugin MCP server, and warns about the Claude Code
  `harnmem@harnmem-marketplace` 0.4.0 install found in
  `~/.claude/plugins/installed_plugins.json` (2026-10-30, Cursor desktop 3.27.22).
- [ ] [U] Behaviour of `postToolUse.additional_context` as a mid-session refresh
  channel.

### 11.1 N24 live verification (2026-10-30, Cursor desktop 3.27.22)

A second probe round exercised the surfaces that N23 left unverified. The setup
was a temporary probe workspace outside the repository, probe scripts that dump
every hook payload to `%TEMP%\harnmem-n24\events.jsonl`, and GUI automation. All
observations below are from that session; the probe hooks were removed afterwards.

| Surface | Result | Evidence |
|---|---|---|
| `beforeSubmitPrompt` injection | still works | Probe hook returned a flat `additional_context` token; the model quoted `BSP-4471` in its first answer, so the undocumented field survived this install |
| `preCompact` | fires, `user_message` only | `/summarize` in a fresh conversation -> hook ran (exit 0, "Merged 1 valid response(s)"). Payload: `trigger: "manual"`, `context_usage_percent: 6.61`, `context_tokens: 16926`, `context_window_size: 256000`, `message_count: 4`, `messages_to_compact: 2`, `is_first_compaction: true`, plus `conversation_id`, `generation_id`, `model` (the summarizer, `gemini-3.7-flash-low`), `session_id`, `transcript_path`. A repeat run on another conversation reported `message_count: 6` / `messages_to_compact: 4` / `is_first_compaction: true`. The response has one field, `user_message`; the returned string showed up as the conversation summary text in Cursor state |
| `subagentStart` / `subagentStop` | fire for Task calls | Payload: `subagent_id` (`call-...` plus a newline and `fc_...`), `subagent_type: "explore"`, `task`, `parent_conversation_id`, `tool_call_id`, `subagent_model`, `is_parallel_worker`, `parent_agent_id`; `subagentStop` added `status: "error"` and `duration_ms` |
| Project hooks | load and run | `<workspace>/.cursor/hooks.json` -> hooks log `Loaded 2 project hook(s) for steps: beforeSubmitPrompt, sessionEnd`; execution log `Executing hook 1/N from project config` with `Running script in directory: <workspace>` |
| MDM / Enterprise hooks | load and run | `C:\ProgramData\Cursor\hooks.json` appeared as the enterprise source; hooks hot-reloaded (`Loaded 1 enterprise hook(s)`) and the command ran with `Running script in directory: C:\ProgramData\Cursor`. One prompt with enterprise + project + user sources executed four hooks in the order `enterprise`, `project`, `user`, `user` |
| Third-party import off | plugin hooks stop | After unchecking "Include Third-Party Plugins, Skills, and Other Configs", the service logs `Claude Code hooks disabled (thirdPartyExtensibilityEnabled off)` and the Claude-imported plugin no longer contributes hooks; only the user-level entries execute |
| Workspace trust (untrusted branch) | not reproduced | Every window opened through the CLI launcher (`cursor.cmd -n <dir>`) was auto-trusted, including a `%TEMP%` directory, so project hooks always loaded. The untrusted branch is only documented by the workbench source (`Project hooks disabled in untrusted workspace`) |
| Cloud agents | not available | The account cannot launch Cloud agents, and the official docs state that Cloud agents skip `sessionStart`, `sessionEnd`, `beforeMCPExecution`, `afterMCPExecution` and `workspaceOpen`, and redact HTTP MCP `postToolUse` output |

The adapter itself does not register `preCompact` or the subagent events: the
former only feeds the summarizer prompt, and the latter describe child agents
whose transcripts the parent `sessionEnd` journal does not need. They were probed
to document the surface, not to extend the write path.

## 12. Unverified items and risks

| Level | Item | Impact / mitigation |
|---|---|---|
| [U] | `beforeSubmitPrompt.additional_context` is undocumented and may change | Rules + MCP keep working; the hook is fail-open; probe tokens in §11 make regressions detectable |
| [U] | Maximum accepted size of `additional_context` | 10,000-byte cap with visible truncation marker; the snapshot normally fits in ~3 KB |
| [U] | `postToolUse` / `preToolUse` injection as refresh channel | Deferred; one-injection-per-conversation is intentional for prompt caching |
| [U] | Cloud agents / remote workspaces | They run only project command hooks and skip several events; the adapter is desktop-first, README says so |
| [U] | `MainThreadShellExec not initialized` on hook teardown | The hook tolerates it (empty stdout, exit 0); observed with the installed Claude plugin |
| [U] | Windows path encoding for `projects/<enc-cwd>` on other drives/UNC | The parser receives `transcript_path` from Cursor, so it never derives the path itself |
| [U] | Cursor version drift for the plugin-hook gate (`enable_cc_plugin_import`) | Installer path is independent of that gate; re-test the plugin path after Cursor updates |
| [V] | Cursor imports a Claude Code `harnmem` plugin, so Customize lists two plugins | Harmless (one MCP server, claims dedupe the hooks); `--doctor` reports it and README documents unchecking "Include Third-Party Plugins, Skills, and Other Configs" or uninstalling the Claude Code copy |

## 13. Differences from the Claude adapter and from 07 §6

1. **Injection trigger**: Claude fires `SessionStart` once and the adapter relies
   on the official `hookSpecificOutput.additionalContext`; Cursor's `sessionStart`
   output is dropped on 3.27.22, so the trigger moves to the first
   `beforeSubmitPrompt` and uses an undocumented flat `additional_context`.
2. **Idempotency**: because the trigger is per-prompt, the adapter adds a
   conversation marker; the Claude adapter re-runs `sessionStart` per session
   start without such a guard.
3. **Distribution**: the Claude adapter ships hooks inside the plugin and needs no
   installer; Cursor only loads plugin hooks through a gated experiment (and, on
   this version, only at startup -- not after a window reload), so the hook layer
   is written by an idempotent merge script into `~/.cursor/hooks.json`, while the
   plugin carries rules + MCP; when both channels do run, exclusive claims keep
   the injection and the journal single-shot.
4. **Transcript**: the Cursor transcript is a subset of the Claude one (text
   only, JSONL with `turn_ended`), so `parseCursorTranscript` is a separate
   parser rather than a reuse of the Claude one.
5. **07 §6** wrote a bare `@harnmem/mcp` package registered by hand; this document
   moves the Cursor integration to a native `.cursor-plugin` package plus an
   installer, mirroring the plugin direction taken by the Claude adapter.

## 14. References

- Cursor hooks reference: https://cursor.com/docs/agent/hooks --event list, output
  schemas, matchers, configuration sources/priority, trust and timeout semantics,
  third-party (Claude) compatibility, Cloud-agent restrictions.
- Cursor plugins reference: https://cursor.com/docs/reference/plugins --
  `.cursor-plugin/plugin.json`, discovered directories, `${CURSOR_PLUGIN_ROOT}`,
  local development plugins, marketplace file, publishing.
- Third-party hooks: https://cursor.com/docs/reference/third-party-hooks --
  `.claude/settings*.json` mapping and the plugin-import gate.
- Internal: [research/cursor-plugin.md](../research/cursor-plugin.md) (first-hand
  probe record and corrections to the 2026-10-29 research),
  [07](07-adapter-contract.md) (facade + four-layer contract),
  [09](09-claude-adapter.md) (sibling adapter),
  [08](08-dsh-adapter.md) (isomorphic approach),
  [03](03-retrieval.md) §5 (injection budget).
