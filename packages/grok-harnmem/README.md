# grok-harnmem — HarnMem memory for Grok CLI

Cross-harness persistent memory for [Grok CLI](https://github.com/xai-org/grok-cli), powered by [`@harnmem/core`](../../README.md). One store (`~/.harnmem/`), shared with the pi, DSH, Claude Code, Codex and opencode adapters: a preference or decision captured in one harness is visible in every other one.

## What it does

- **Injected memory index** — a byte-stable snapshot of your hottest memories reaches the model before the first turn through the MCP server's `initialize.instructions`, which Grok injects as the `<system-reminder>` titled "MCP servers connected: …". Empty store ⇒ nothing injected. The snapshot only rebuilds on session start, after a write, or at day rollover, so prompt caching stays intact across turns.
- **Six MCP tools** — the five canonical `memory_search`, `memory_read`, `memory_write`, `memory_forget`, `memory_status` tools plus `memory_context`, which returns the full index when Grok's aggregate reminder cap cut the injected copy. Grok exposes plugin MCP tools as `harnmem__*` and the model may inspect schemas through `search_tool` first.
- **`/grok-harnmem:memory` command** — a manual operator entry point to search/read/write/forget/status/context without leaving the chat (plugin commands are namespaced by the plugin name).
- **Session-end extraction** — the `SessionEnd` hook journals the transcript tail and hands it to a detached child process, so the hook returns inside Grok's 1.5 s plugin budget and extraction never blocks your exit. It reads `chat_history.jsonl` (falling back to `updates.jsonl`) from the Grok session directory.
- **Subagent-safe** — sessions carrying `subagentType` run read-only and never extract; only the main session writes.

### Why not a SessionStart hook?

Grok 1.0.70 renders the system prompt **before** `SessionStart` hooks run, and `SessionStart` is observe-only: `hookSpecificOutput.additionalContext` and plain stdout are dropped, and a top-level `systemMessage` only reaches the client UI. The Claude Code injection path therefore cannot work on Grok; the MCP handshake is the only model-visible pre-turn channel a plugin can use per project (the global `<GROK_HOME>/rules/` channel also loads, but it is shared by every project, so a project-scoped index there would leak between repositories). Details and probe evidence: [`docs/research/grok-plugin.md`](../../docs/research/grok-plugin.md).

## Install

The repo root is a Grok marketplace (`.grok-plugin/marketplace.json`). From a checkout:

```
grok plugin marketplace add <path-to-this-checkout>
grok plugin install grok-harnmem --trust
```

Or install the package directory directly:

```
grok plugin install <path-to-this-checkout>/packages/grok-harnmem --trust
```

`--trust` is required the first time: Grok does not load a plugin's hooks, MCP servers, commands or skills until it is trusted. Existing installs can be trusted from the `/plugins` modal instead. `grok plugin install` copies the package into `<GROK_HOME>/installed-plugins/` and records it in `[plugins] enabled`; that explicit entry is also what makes this plugin win the shared `harnmem` MCP server name when Grok also discovers the Claude Code plugin (see Compatibility notes).

During development, `--plugin-dir` works for the ACP route:

```
grok agent --plugin-dir packages/grok-harnmem stdio
```

`@harnmem/core` is vendored into `vendor/core/` at build time (`pnpm build` in this package), so the installed plugin directory is self-contained.

## Configuration

Environment first, then files — malformed config is ignored, never fatal:

1. `HARNMEM_DISABLED`, `HARNMEM_READONLY`, `HARNMEM_DEBUG`, `HARNMEM_AUTO_EXTRACT`, `HARNMEM_INJECT`, `HARNMEM_HOME`
2. `~/.harnmem/config.json` (shared with every adapter)
3. `<project>/.harnmem.json`

Grok-specific knobs:

- `HARNMEM_GROK_MAX_INSTRUCT_BYTES` (default `2500`) — byte cap for the injected index. Grok truncates the aggregate "MCP servers connected" reminder at roughly 4.3 KB when other servers also declare instructions; keep this small and use `memory_context` for the full copy.
- `HARNMEM_GROK_MAX_INJECT_TOKENS` (default `1200`) — core's retrieval budget for the snapshot itself.

Extraction is dry by default (`autoExtract: false`): the session transcript is journaled but no LLM is called. Set `autoExtract: true` in `~/.harnmem/config.json` and wire the shared `llm` config to extract durable memories at session end; without an LLM the store records `status: no_llm` in the audit log and nothing is written.

## Compatibility notes

- **Claude Code plugins are auto-loaded by Grok.** If `claude-harnmem` is installed for Claude Code, Grok also discovers it, and both plugins declare an MCP server named `harnmem`. Grok keeps exactly one, and the plugin that `grok plugin install` explicitly enabled — this one — wins, so a session gets the six tools and the injected index (verified on 1.0.70). The auto-loaded copy's `SessionEnd` hook still fires alongside ours; it is harmless (it cannot parse Grok's transcript, so it extracts nothing), but for a single extractor add this to `~/.grok/config.toml`:

  ```toml
  [plugins]
  enabled = ["grok-harnmem"]   # already written by `grok plugin install`
  disabled = ["harnmem"]       # unload the auto-loaded Claude copy
  ```

  The `disabled` entry is harmless when no Claude plugin is installed. Verify with `grok plugin list` (only `grok-harnmem` appears as a Grok-installed plugin) and `grok inspect --json` (the `harnmem` MCP server should resolve under `installed-plugins/`, not `~/.claude/plugins/`). Do not disable the Claude plugin in Claude Code — each harness keeps its own plugin set.
- **Sandbox.** Grok's sandbox is enforced on Linux (Landlock) and macOS (Seatbelt) only; Windows is unaffected. On Linux/macOS, `read-only` and `strict` profiles do not include `~/.harnmem` in their write set and the sandbox covers the whole Grok process (MCP server included), so memory tools degrade to read-only. Add a custom profile to `~/.grok/sandbox.toml`:

  ```toml
  [profiles.harnmem]
  extends = "workspace"
  read_write = ["/home/<user>/.harnmem"]   # macOS: /Users/<user>/.harnmem
  ```

  then run `grok --sandbox harnmem` (or set `[sandbox] profile = "harnmem"`). `read_write` entries are literal absolute paths — Grok does not expand `~`. Alternatively point `HARNMEM_HOME` inside the workspace for a scratch store, or set `HARNMEM_READONLY=1` to accept the degraded mode explicitly.
- **Windows manifests must be BOM-less.** A UTF-8 BOM makes Grok silently skip a plugin's `plugin.json` / `hooks.json`; all JSON shipped in this package is BOM-less and the tests pin that.
- **Grok's own memory (`/memory`, `memory_v2`) is a separate feature.** It is off by default; HarnMem's value is the plain-Markdown store shared with your other harnesses.
- **Windows long paths.** Grok copies plugins under `<GROK_HOME>/installed-plugins/<long id>/`; keep `GROK_HOME` short (for example the default `%USERPROFILE%\.grok`) so the package path stays under the legacy 260-character limit.

## Notes

- The MCP server never writes to stdout outside the JSON-RPC protocol; hook scripts print nothing and exit 0 on any failure so a broken adapter can never wedge a session.
- MCP tools are not in Grok's tool definitions, so the model reaches them through `search_tool` / `use_tool`; the injected index appends a `memory_context` pointer only when the index was truncated, and `memory_context` stays available for a full pull at any time.
- The hook only registers `SessionEnd`; no `SessionStart` hook exists by design (see above).
- Design and verification evidence: `docs/design/11-grok-adapter.md`, `docs/research/grok-plugin.md`.

## License

MIT — see [LICENSE](./LICENSE).
