# opencode-harnmem — HarnMem memory for opencode

Cross-harness persistent memory for [opencode](https://opencode.ai) v2.x, powered by [`@harnmem/core`](../../README.md). One store (`~/.harnmem/`), shared with the pi / DSH / Claude / Codex adapters: a preference or decision captured in one harness is visible in every other one on the next session start.

## What it does

- **Stable injection** — a `session.hook("context")` callback pushes a byte-stable snapshot of your hottest memories as a system part. Empty store ⇒ zero parts pushed. The snapshot is computed once per session and only rebuilt after a write or at day rollover, so prompt caching stays intact across turns.
- **Five native tools** — `memory_search`, `memory_read`, `memory_write`, `memory_forget`, `memory_status` registered through `tool.transform`. No MCP child process: the tools run in-process against the vendored core.
- **Per-turn journaling** — every `session.hook("prompt")` appends the transcript tail (capped: 400 messages × 4,000 chars) to the shared session journal, deduplicated by signature, so another harness (or a future `harnmem` CLI extraction pass) can mine this session later. Two caveats, both inherent to the hook firing before the current turn's messages exist: single-turn CLI runs journal nothing, and the **final turn of any session is captured only when that session continues later** (`--continue` / TUI resume). Extraction with an in-process LLM (`ctx.generate.text`) is planned for v0.2; the journal is written today regardless.
- **Subagent-safe** — child sessions (`parentID` set) run read-only: no injection, no journaling, and the write tool answers read-only instead of writing.

## Install

Add the package to your `opencode.json`:

```json
{ "$schema": "https://opencode.ai/config.json", "plugin": ["opencode-harnmem"] }
```

From a checkout, point the entry at the package directory (verified to load local packages):

```json
{ "plugin": ["D:/projects/harnmem/packages/opencode-harnmem"] }
```

`@harnmem/core` is vendored into `vendor/core/` at build time (`pnpm build` in this package), so the plugin directory is self-contained. Requires opencode >= 2 (the `{ id, setup }` plugin contract); on opencode 1.x the plugin prints one line and does not load.

## Configuration

Environment first, then files — malformed config is ignored, never fatal:

1. `HARNMEM_DISABLED`, `HARNMEM_READONLY`, `HARNMEM_DEBUG`, `HARNMEM_AUTO_EXTRACT`, `HARNMEM_INJECT`, `HARNMEM_OPENCODE_MAX_INJECT_TOKENS`, `HARNMEM_HOME`
2. `~/.harnmem/config.json` (shared with every adapter)
3. `<project>/.harnmem.json`

Injection is capped at 10,000 bytes with deterministic line-based truncation (same rule as the Claude adapter).

## Notes

- Tools map bare non-object arguments onto their single required key (probed: opencode can deliver `args` as a raw string) and every tool call degrades to a friendly text result instead of an error.
- All failures are swallowed at the plugin boundary: a broken store can never wedge a session.
- Design and verification evidence: `docs/research/opencode-plugin.md` (contract probe log included).

## License

MIT — see [LICENSE](./LICENSE).
