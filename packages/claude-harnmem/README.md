# claude-harnmem — HarnMem memory for Claude Code

Cross-harness persistent memory for [Claude Code](https://docs.claude.com/en/docs/claude-code), powered by [`@harnmem/core`](../../README.md). One store (`~/.harnmem/`), shared with the pi and DSH adapters: a preference or decision captured in one harness is visible in every other one on the next session start.

## What it does

- **Stable injection** — a `SessionStart` hook prints a byte-stable snapshot of your hottest memories into the session context. Empty store ⇒ zero bytes injected. The snapshot only rebuilds on session start/resume/compact, after a write, or at day rollover, so prompt caching stays intact across turns.
- **Five MCP tools** — `memory_search`, `memory_read`, `memory_write`, `memory_forget`, `memory_status` over a zero-dependency stdio MCP server, so the model can pull memories on demand and store durable ones explicitly (ADD-only, bi-temporal supersede, trash restore).
- **`/harnmem:memory` command** — a manual operator entry point to search/read/write/forget/status without leaving the chat (plugin commands are namespaced by the plugin name `harnmem`).
- **Session-end extraction** — the session transcript tail is journaled and re-processed by a detached child process, so the hook returns instantly (plugin hook timeouts are not honored upstream) and extraction never blocks your exit.
- **Subagent-safe** — subagent sessions (`agent_type` set) run read-only and never extract; only the main session writes.

## Install

The repo root is also a Claude Code marketplace (`.claude-plugin/marketplace.json`). From a checkout:

```
claude plugin marketplace add <path-to-this-checkout>   # or ys118/harnmem once public
claude plugin install harnmem@harnmem-marketplace
```

The marketplace entry points at `packages/claude-harnmem`, so an install from a checkout reads the checkout live — code changes apply on the next session without reinstalling.

Or during development, load the package directly for one session:

```
claude --plugin-dir packages/claude-harnmem
```

`@harnmem/core` is vendored into `vendor/core/` at build time (`pnpm build` in this package), so the installed plugin directory is self-contained.

## Configuration

Environment first, then files — malformed config is ignored, never fatal:

1. `HARNMEM_DISABLED`, `HARNMEM_READONLY`, `HARNMEM_DEBUG`, `HARNMEM_AUTO_EXTRACT`, `HARNMEM_INJECT`, `HARNMEM_CLAUDE_MAX_INJECT_TOKENS`, `HARNMEM_HOME`
2. `~/.harnmem/config.json` (shared with every adapter)
3. `<project>/.harnmem.json`

Injection is additionally capped at Claude Code's 10,000-character `additionalContext` limit with deterministic line-based truncation.

## Notes

- The MCP server never writes to stdout outside the JSON-RPC protocol; hook scripts print at most one JSON payload and exit 0 on any failure so a broken adapter can never wedge a session.
- `PreCompact` is intentionally not registered: Claude Code re-fires `SessionStart(source=compact)` and keeps the transcript file, which already rebuilds the snapshot.
- Design and verification evidence: `docs/design/09-claude-adapter.md`, `docs/research/claude-code-plugin.md`.

## License

MIT — see [LICENSE](./LICENSE).
