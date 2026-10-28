# codex-harnmem — HarnMem memory for Codex

Cross-harness persistent memory for the [Codex CLI](https://developers.openai.com/codex), powered by [`@harnmem/core`](../../README.md). One store (`~/.harnmem/`), shared with the pi, DSH and Claude adapters: a preference or decision captured in one harness is visible in every other one on the next session start.

## What it does

- **Stable injection** — a plugin `SessionStart` hook (type `mcp_tool`) calls the internal `memory_context` tool, and Codex materializes the returned text as a developer message (`hooks.additional_context` in the rollout). The snapshot is byte-stable: empty store → zero bytes injected; rebuilds only on session start/resume/compaction, after a write, or at day rollover, so prompt caching stays intact across turns.
- **Five canonical MCP tools** — `memory_search`, `memory_read`, `memory_write`, `memory_forget`, `memory_status` over a zero-dependency stdio MCP server (`.mcp.json` with an `env_vars` allowlist), exposed to the model as `mcp__harnmem__memory_*`.
- **Two internal hook tools** — `memory_context` (SessionStart target) and `memory_session_end` (SessionEnd target). They appear in `tools/list` but exist for the hook framework; the model can ignore them.
- **Skill** — `harnmem:harnmem` teaches the model when to search (before re-asking known preferences) and when to write (durable user/feedback/project/reference facts only).
- **Session-end extraction** — `memory_session_end` writes a payload file and spawns a detached worker (`lib/extract-worker.mjs`) that parses the Codex rollout (`lib/rollout.mjs`) and feeds the transcript tail to `HarnMem.sessionEnd`, so the hook returns instantly and extraction never blocks session teardown.
- **Session anchoring** — the hook templates carry the real Codex thread id (`${session_id}`); the first non-empty session id anchors the server's engine so model-initiated writes are journaled under the same session (`source.harness = "codex"`).

## Verified constraints (codex-cli 0.164.0-alpha.11.1, Windows, 2026-10-28)

- **SessionEnd MCP hooks are not supported yet** — Codex logs `skipping MCP tool hook … SessionEnd MCP hooks are not supported` at startup and skips the hook. The declaration is kept on purpose: injection and tools work today, and extraction activates with zero changes once Codex ships support. The warning is harmless. Until then, memories reach the store via explicit model writes (`memory_write`) or the other adapters.
- **Hook trust** — when hook trust for a locally-installed plugin has not been persisted, Codex silently skips `SessionStart` hooks in `codex exec`; pass `--dangerously-bypass-hook-trust` for unattended runs (or approve hooks once in the desktop app).
- **MCP write approvals in exec** — with the default approval policy, model calls to `memory_write` fail with `Unable to write: MCP approval is disabled.`; use an approval mode that allows MCP tools (e.g. `--dangerously-bypass-approvals-and-sandbox`) or approve the call interactively.
- **Project scope follows the exec cwd** — `project`-scoped records live in a per-project shard derived from the working directory. A session started in `D:\a` does not see `project` records written under `D:\a\b`; `user`-scoped records are global.

## Install

The repo root is also a Codex local marketplace (`.agents/plugins/marketplace.json`). From a checkout:

```
codex plugin marketplace add <path-to-this-checkout>
codex plugin add harnmem@harnmem-marketplace
```

Codex copies the package into `~/.codex/plugins/cache/<marketplace>/<name>/<version>/` and adds a `[plugins."harnmem@harnmem-marketplace"]` block plus the marketplace entry to `config.toml`. Run `codex mcp list` to confirm the `harnmem` server is enabled.

> An npm-published package and GitHub sparse-checkout install are tracked in ROADMAP N16.

## Uninstall

```
codex plugin remove harnmem@harnmem-marketplace
codex plugin marketplace remove harnmem-marketplace
```

Verified byte-identical: `config.toml` hashes equal before install and after removal; Codex deletes the cache directory.

## Configuration

Same priority chain as the other adapters: `~/.harnmem/config.json` → `<cwd>/.harnmem.json` → environment. Malformed config is ignored, never fatal. Codex-specific environment variables (all optional; forwarded through the MCP `env_vars` allowlist):

| Variable | Meaning |
| --- | --- |
| `HARNMEM_HOME` | Store root (default `~/.harnmem`) |
| `HARNMEM_CODEX_MAX_INJECT_TOKENS` | Snapshot token budget (default `1200`) |
| `HARNMEM_DISABLED` / `HARNMEM_READONLY` / `HARNMEM_INJECT` | Kill switches (`1`/`0`) |
| `HARNMEM_DEBUG` | Engine + server logs on stderr |
| `HARNMEM_EXTRACT_SYNC` | Run extraction inline instead of detached (debugging) |
| `CODEX_HOME` | Where to look for rollouts (default `~/.codex`) |

Injection is additionally capped at 10,000 characters with deterministic line-based truncation.

## Development

```
pnpm --filter codex-harnmem build   # vendor @harnmem/core into vendor/core/
pnpm --filter codex-harnmem test    # 9 deterministic tests, no Codex needed
```

Tests spawn the real MCP server over stdio (initialization, tool round-trips, byte-stable injection, rollout parsing, payload journaling) against a temporary store. Design notes and the full probe record live in [`docs/research/codex-plugin.md`](../../docs/research/codex-plugin.md).

## License

MIT — see [LICENSE](./LICENSE).
