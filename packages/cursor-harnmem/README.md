# cursor-harnmem — HarnMem memory for Cursor

Cross-harness persistent memory for [Cursor](https://cursor.com), powered by [`@harnmem/core`](../../README.md). One store (`~/.harnmem/`), shared with the Claude Code, Codex, pi, DSH and opencode adapters: a preference or decision captured in one harness is visible in every other one on the next conversation.

## What it does

- **First-prompt injection** — after the one-line installer, a `beforeSubmitPrompt` hook injects a byte-stable snapshot of your hottest memories once per conversation. Empty store ⇒ zero bytes injected. Later prompts of the same conversation are skipped, so the injected text never changes mid-conversation and prompt caching stays intact.
- **Five MCP tools** — `memory_search`, `memory_read`, `memory_write`, `memory_forget`, `memory_status` over a zero-dependency stdio MCP server, so the model can pull memories on demand and store durable ones explicitly (ADD-only, bi-temporal supersede, trash restore).
- **Conversation-end journaling** — the `sessionEnd` hook journals the transcript tail to `~/.harnmem/sessions/` and extracts durable facts. The extraction runs in a detached child process, so the hook returns instantly and never blocks Cursor's exit (background agents are skipped).
- **Rules fallback** — `rules/harnmem.mdc` (`alwaysApply: true`) ships inside the plugin, so marketplace installs and builds where the injection channel is unavailable still teach the model to reach the store through the MCP tools.

## Install

For the desktop app, use the installer from this package (it copies the plugin into `~/.cursor/plugins/local/harnmem` and registers the hooks in your user-level `~/.cursor/hooks.json`):

```
pnpm --filter cursor-harnmem build
npx cursor-harnmem-install   # or: node packages/cursor-harnmem/scripts/install.mjs
```

Then run **Developer: Reload Window** (or restart Cursor) and check **Customize → Plugins**.

Why the installer exists: Cursor desktop 3.27.22 loads a user-local plugin's `rules/` and `mcp.json`, but **not** its `hooks/hooks.json` — plugin hooks are gated behind the `enable_cc_plugin_import` experiment (see `docs/research/cursor-plugin.md` §2.3). The reliable hook surface is the user-level `~/.cursor/hooks.json`, which the installer merges into non-destructively (timestamped backup, `--uninstall` reverses it, existing hooks are never overwritten).

Useful flags:

```
node packages/cursor-harnmem/scripts/install.mjs --dry-run
node packages/cursor-harnmem/scripts/install.mjs --mcp-user   # also ~/.cursor/mcp.json
node packages/cursor-harnmem/scripts/install.mjs --uninstall
node packages/cursor-harnmem/scripts/install.mjs --doctor     # self-check, see below
```

`@harnmem/core` is vendored into `vendor/core/` at build time (`pnpm build` in this package), so the installed plugin directory is self-contained.

## Install from the Cursor Marketplace

Installing this plugin from the Cursor Marketplace gives you the `rules/` guidance and the five MCP tools right away: the model knows memory exists and can search, read and write records from its first reply. Cursor gates plugin-provided hooks behind its Claude Code plugin-import experiment, so `hooks/hooks.json` is **not** executed for a marketplace install on 3.27.22 — the injector and the session-end journal need the user-level hook registration:

```
npx cursor-harnmem-install
```

That one command copies the plugin into `~/.cursor/plugins/local/harnmem` and merges the three hook entries into `~/.cursor/hooks.json` (idempotent, timestamped backup, `--uninstall` reverses it). After **Developer: Reload Window** you get the byte-stable snapshot on the first prompt of every conversation, plus transcript journaling at session end. Without it you keep the rules fallback: the model calls `memory_search` itself instead of reading an injected index.

## Two HarnMem plugins in Cursor

Cursor imports Claude Code configuration on boot (**Settings → Chat → "Include Third-Party Plugins, Skills, and Other Configs"**, stored as `thirdPartyExtensibilityEnabled`). If `claude-harnmem` is installed for Claude Code, Cursor lists a second plugin named `harnmem` next to this one, read from `~/.claude/plugins/cache/…`.

That duplicate is harmless: Cursor registers a single MCP server named `harnmem`, and the two copies of the hook script are deduplicated by exclusive claim files, so the memory snapshot is injected once and extraction journals the conversation once. To have only the native Cursor plugin listed, either uncheck that setting or uninstall the Claude Code copy (`/plugin uninstall harnmem@harnmem-marketplace`).

The installer ends with a doctor pass and the same checks are available on demand:

```
node packages/cursor-harnmem/scripts/install.mjs --doctor
```

It reports the plugin manifest, the registered hook events, the MCP server and whether the Claude Code registry at `~/.claude/plugins/installed_plugins.json` contains a second `harnmem` install (warning only). It exits `1` when the plugin, its hooks or its MCP server are missing, so it can gate a setup script. `HARNMEM_CLAUDE_HOME` overrides the Claude Code directory used by the check.

## Configuration

Environment first, then files — malformed config is ignored, never fatal:

1. `HARNMEM_DISABLED`, `HARNMEM_READONLY`, `HARNMEM_DEBUG`, `HARNMEM_AUTO_EXTRACT`, `HARNMEM_INJECT`, `HARNMEM_CURSOR_MAX_INJECT_TOKENS`, `HARNMEM_HOME`
2. `<project>/.harnmem.json`
3. `~/.harnmem/config.json` (shared with every adapter)

Injection is deterministically truncated to a conservative 10,000-character budget (`HARNMEM_CURSOR_MAX_INJECT_TOKENS` controls the retrieval budget in tokens).

## Notes

- The MCP server never writes to stdout outside the JSON-RPC protocol; hook scripts print at most one JSON payload and exit 0 on any failure, so a broken adapter can never wedge a conversation.
- Project-level `.cursor/hooks.json` also works (it needs a trusted workspace), but the installer targets the user level because that is what was verified end-to-end.
- Cursor's published hook schema documents `continue`/`user_message` for `beforeSubmitPrompt`, not `additional_context`. The injection channel used here was verified by token-recall experiments on 3.27.22; if a future Cursor build drops it, the `rules/harnmem.mdc` fallback still exposes the store through the MCP tools.
- Design and verification evidence: `docs/design/12-cursor-adapter.md`, `docs/research/cursor-plugin.md`.

## License

MIT — see [LICENSE](./LICENSE).
