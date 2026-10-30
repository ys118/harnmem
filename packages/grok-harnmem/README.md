# grok-harnmem — HarnMem memory for Grok CLI

Cross-harness persistent memory for [Grok CLI](https://github.com/xai-org/grok-cli), powered by [`@harnmem/core`](../../README.md). One store (`~/.harnmem/`), shared with the pi, DSH, Claude Code, Codex and opencode adapters: a preference or decision captured in one harness is visible in every other one.

## What it does

- **Injected memory index** — a byte-stable snapshot of your hottest memories reaches the model before the first turn through the MCP server's `initialize.instructions`, which Grok injects as the `<system-reminder>` titled "MCP servers connected: …". Empty store ⇒ nothing injected. The snapshot only rebuilds on session start, after a write, or at day rollover, so prompt caching stays intact across turns.
- **Six MCP tools** — the five canonical `memory_search`, `memory_read`, `memory_write`, `memory_forget`, `memory_status` tools plus `memory_context`, which returns the full index when Grok's aggregate reminder cap cut the injected copy. Grok exposes plugin MCP tools as `harnmem__*` and the model may inspect schemas through `search_tool` first.
- **`/grok-harnmem:memory` command** — a manual operator entry point to search/read/write/forget/status/context without leaving the chat (plugin commands are namespaced by the plugin name).
- **Session-end extraction** — the `SessionEnd` hook journals the transcript tail and hands it to a detached child process, so the hook returns inside Grok's 1.5 s plugin budget and extraction never blocks your exit. It reads `chat_history.jsonl` (falling back to `updates.jsonl`) from the Grok session directory.
- **Subagent-safe** — sessions carrying `subagentType` run read-only and never extract; only the main session writes.

### Why not a SessionStart hook?

Grok 1.0.70 renders the system prompt **before** `SessionStart` hooks run, and `SessionStart` is observe-only: `hookSpecificOutput.additionalContext` and plain stdout are dropped, and a top-level `systemMessage` only reaches the client UI. The Claude Code injection path therefore cannot work on Grok; the MCP handshake is the only model-visible pre-turn channel. Details and probe evidence: [`docs/research/grok-plugin.md`](../../docs/research/grok-plugin.md).

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

`--trust` is required the first time: Grok does not load a plugin's hooks, MCP servers, commands or skills until it is trusted. Existing installs can be trusted from the `/plugins` modal instead.

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

- **Claude Code plugins are auto-loaded by Grok.** If `claude-harnmem` is installed for Claude Code, Grok may also load its MCP server and hooks. Run both only if you want two `harnmem` MCP servers; otherwise disable one (`grok plugin disable harnmem`) and keep `grok-harnmem`.
- **Sandbox.** Grok's stricter sandbox profiles can leave `~/.harnmem` unwritable, which turns memory tools read-only. Add it to the writable set, or point `HARNMEM_HOME` inside the sandbox for a scratch store.
- **Windows manifests must be BOM-less.** A UTF-8 BOM makes Grok silently skip a plugin's `plugin.json` / `hooks.json`; all JSON shipped in this package is BOM-less and the tests pin that.
- **Grok's own memory (`/memory`, `memory_v2`) is a separate feature.** It is off by default; HarnMem's value is the plain-Markdown store shared with your other harnesses.

## Notes

- The MCP server never writes to stdout outside the JSON-RPC protocol; hook scripts print nothing and exit 0 on any failure so a broken adapter can never wedge a session.
- The hook only registers `SessionEnd`; no `SessionStart` hook exists by design (see above).
- Design and verification evidence: `docs/design/11-grok-adapter.md`, `docs/research/grok-plugin.md`.

## License

MIT — see [LICENSE](./LICENSE).
