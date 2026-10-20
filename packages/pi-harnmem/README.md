# pi-harnmem

Long-term, plain-file memory for [pi](https://github.com/earendil-works/pi) — the pi adapter for [harnmem](../../README.md).

Memory is stored as Markdown in `~/.harnmem` (no service, no database, no local embedding model). The extension injects a small, byte-stable memory index into the session system prompt and exposes 5 tools so the model can write, search, read, forget and inspect memory across sessions and projects.

Requires `pi >= 1.3.0`. Status: **v0.1.0 — pi only** (DSH / Claude Code adapters are designed, not implemented).

## Install

Build first, from the repo root:

```bash
pnpm install
pnpm -r build
```

### Install into pi (local path)

```bash
pi install ./packages/pi-harnmem
# -l / --local installs into the current project's settings instead of user settings
```

Verified syntax against `pi install --help` (pi 1.3.0). The full install flow is not covered by the repo's automated checks — if it fails, use the dev loading path below.

### Dev loading (no install)

```bash
pi -e ./packages/pi-harnmem/dist/index.js
```

Verified end-to-end against a real pi 1.3.0 session: empty-store load, write, cross-session recall, byte-stable injection, read-only children.

### npm

Not published yet (`pi install npm:pi-harnmem` is a v0.2 target).

## Quick start

In a pi session:

```text
You: remember this project uses pnpm — never npm install.
pi:  → memory_write(...) → stored mem_01J8... (NEW)
```

Next session, the hot index is injected automatically:

```markdown
## HarnMem memory (cross-harness; stable snapshot)

- 📌 [user] Dependencies in this project use pnpm — never npm install (avoids lockfile drift) (mem_01J8...)

<!-- SSOT: ~/.harnmem. Use memory_search for details; never invent memory ids. ... -->
```

An empty store injects **nothing** (0 bytes).

## Configuration

Settings are read (lowest → highest priority) from: built-in defaults → `<home>/config.json` → `<cwd>/.harnmem.json` → `<agentDir>/harnmem.json` → environment variables. `agentDir` is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. JSONC comments are allowed; a malformed file produces a warning, never a crash.

`<agentDir>/harnmem.json`:

```jsonc
{
  "enabled": true,          // master switch
  "inject": true,           // inject hot index at session start
  "readOnly": false,        // block all writes
  "autoExtract": false,     // background extraction on session quit (opt-in)
  "home": "~/harnmem-home",  // default: ~/.harnmem
  "maxInjectTokens": 1200,  // injection budget (800..2000 recommended)
  "maxSearchTokens": 1200,
  "model": {                // LLM used for extraction/consolidation
    "provider": "<provider>",
    "id": "<model>",
    "reasoning": "low",
    "timeoutMs": 60000
  },
  "log": "errors",          // off | errors | on  → <home>/logs/pi.jsonl
  "debug": false
}
```

Environment overrides: `HARNMEM_HOME`, `HARNMEM_DISABLED=1`, `HARNMEM_READONLY=1`, `HARNMEM_INJECT=1|0`, `HARNMEM_AUTO_EXTRACT=1`, `HARNMEM_DEBUG=1`.

## Tools (model-facing)

| Tool | Parameters | Notes |
|---|---|---|
| `memory_write` | `type` (user/feedback/project/reference), `title`, `description`, `content`, `category`, `scope` (auto/user/project), `importance` (0–10), `confidence` (0–1), `pinned`, `tags`, `entities`, `links`, `supersedes`, `evidence` | Returns one line: `stored … (NEW)` / `already exists … (SKIP)` / `merged into … (MERGE)` / `superseded … → …` / `linked to existing … (LINK)` |
| `memory_search` | `query`, `limit` (8), `scope`, `project`, `include_archived`, `include_history`, `as_of`, `entity`, `debug` | BM25F + synonyms + link diffusion; abstains when not confident |
| `memory_read` | `id`, `as_of`, `include_history` | Frontmatter summary + body + backlinks |
| `memory_forget` | `id`, `hard` | Default moves to `trash/` (30-day grace); `hard` is permanent |
| `memory_status` | — | Shards, index state, health, extraction counters |

`memory_write` marks the snapshot dirty; every successful write refreshes the injected index in the next step.

## Commands (human-facing)

```text
/memory status
/memory search <q> [--limit N]
/memory read <id> [--history]
/memory forget <id> [--hard]
/memory restore <id>
/memory consolidate [--dry-run] [--mechanical]
/memory help
```

## How it works

- **Stable snapshot (Option-P):** the context block is rebuilt only on session start, before compaction, after a successful write, and on day rollover. Within a session it is byte-identical, so the provider prompt cache is not invalidated. Rebuild cost is well under 20 ms for typical stores.
- **Injection budget:** `maxInjectTokens` (default 1200). Pinned entries first, then user/project/digest sections; whole entries only. Body text is never injected — the model calls `memory_read` for detail.
- **Read-only children:** subagent sessions (child markers such as `PI_SUBAGENT_CHILD`) get no LLM and cannot write: `memory_write failed: HarnMem is read-only`.
- **Session end:** the transcript (last ≤200 messages, assistant truncated) is journaled; when `autoExtract` is on, extraction runs at quit with an 8 s hard timeout, ≥3 user messages, and is skipped if the model wrote a memory itself that session. Extracted candidates below `confidence 0.5` are dropped; at most 6 are stored.
- **Custom extraction prompt:** `<home>/prompts/extract.md` is loaded when present and parsed into `## system` / `## user` sections; placeholders such as `{{observation_date}}`, `{{existing_memories}}` and `{{transcript}}` are substituted into the user template. Missing files or sections fall back to built-in English defaults, and editing the file takes effect on the next extraction without restarting.

## Storage

```text
~/.harnmem/
├── VERSION
├── config.json            # optional engine config (budget/retrieval/write/governance)
├── projects.json          # project registry (git remote / path → projectId)
├── memories/user/         # MEMORY.md index + mem_*.md records
├── memories/projects/<projectId>/
├── index/                 # manifest.json + <shard>.json (rebuildable)
├── digests/<shard>/       # optional topic digests
├── sessions/<date>/       # transcript journals for extraction
├── state/{seq,audit.jsonl,cursors.json}
├── trash/                 # 30-day recycle bin
└── logs/pi.jsonl
```

Plain files are the source of truth: back up or sync `~/.harnmem` directly. The index can always be rebuilt from the Markdown records.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No memory block in context | Empty store (normal); check `/memory status`; check `enabled`/`inject`/`HARNMEM_DISABLED` |
| Write says `HarnMem is read-only` | Subagent session, `readOnly: true`, or `HARNMEM_READONLY=1` |
| `index: ... stale=true` right after a write | Expected: index rebuilds at next session start |
| Extraction reports `failed` | Check LLM availability and `<home>/logs/pi.jsonl` |
| Slow exit (~8 s) | Bounded extraction wait; disable `autoExtract` if not wanted |
| Provider `400` with `--thinking max` | Use `--thinking low` (known provider quirk) |

## Development

```bash
pnpm --filter @harnmem/core build
pnpm --filter pi-harnmem build     # tsc; 44 files emitted to dist/
pnpm test                          # core test suite (19 tests)
```

Source layout: `src/index.ts` (event wiring), `state.ts` (engine lifecycle), `context.ts` (snapshot manager), `tools.ts`, `command.ts`, `llm.ts` (pi model bridge), `journal.ts`, `log.ts`, `subagent.ts`, `config.ts`, `format.ts`.

## Limitations

- pi only; DSH and Claude Code adapters are not implemented.
- No automated tests for this package; behavior is covered by manual end-to-end runs against pi 1.3.0 (real subagent sessions not yet exercised).
- `autoExtract` defaults to off and only runs on normal quit.

## License

MIT
