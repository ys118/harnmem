# omp-harnmem

Long-term, plain-file memory for [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi) — the omp adapter for [harnmem](../../README.md).

Memory is stored as Markdown in `~/.harnmem` (no service, no database, no local embedding model). The extension injects a small, byte-stable memory index into the session system prompt and exposes 5 tools so the model can write, search, read, forget and inspect memory across sessions and projects.

Requires `omp >= 18.14.1` (peer range `<19.0.0`). The same store is shared with the other adapters: [`pi-harnmem`](../pi-harnmem), [`dsh-harnmem`](../dsh-harnmem), and more.

> **Coexistence with omp's built-in memory.** omp ships its own memory backends
> (`memory.backend`: `off` / `local` / `hindsight` / `mnemopi` / `sharpshooter`, default
> `off`). harnmem registers as an ordinary extension (injection + tools + `/memory`), not a
> memory backend — omp has no third-party backend API. Both can coexist; for a single
> source of truth keep `memory.backend: off` (the default) while harnmem is active.

## Install

```bash
omp plugin install @harnmem/omp-harnmem
# --scope project installs into the current project instead of user scope
```

### Install into omp (local path)

For development against a repo checkout:

```bash
pnpm install && pnpm -r build
omp plugin link ./packages/omp-harnmem
```

`omp plugin link` creates a junction under `~/.omp/plugins/node_modules/` and enables the
package in `omp-plugins.lock.json`; `omp plugin list` should show it under "npm Plugins".

### Dev loading (no install)

```bash
omp -e ./packages/omp-harnmem/dist/index.js
```

Explicit `-e` loading bypasses the plugin manager entirely (and still works under
`--no-extensions`, which only disables auto-discovered extensions).

## Quick start

In an omp session:

```text
You: remember this project uses pnpm — never npm install.
omp: → memory_write(...) → stored mem_01J8... (NEW)
```

Next session, the hot index is injected automatically as a trailing system-prompt segment:

```markdown
## HarnMem memory (cross-harness; stable snapshot)

- 📌 [user] Dependencies in this project use pnpm — never npm install (avoids lockfile drift) (mem_01J8...)

<!-- SSOT: ~/.harnmem. Use memory_search for details; never invent memory ids. ... -->
```

An empty store injects **nothing** (0 bytes).

## Configuration

Settings are read (lowest → highest priority) from: built-in defaults → `<home>/config.json` → `<cwd>/.harnmem.json` → `<agentDir>/harnmem.json` → environment variables. `agentDir` is `OMP_AGENT_DIR` (or omp's legacy `PI_CODING_AGENT_DIR`) or `~/.omp/agent`. JSONC comments are allowed; a malformed file produces a warning, never a crash.

`~/.omp/agent/harnmem.json`:

```jsonc
{
  "enabled": true,          // master switch
  "inject": true,           // inject hot index at session start
  "readOnly": false,        // block all writes
  "statusLine": true,       // footer line "harnmem: N entries · ~T tokens · <sha>"; false hides it
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
  "log": "errors",          // off | errors | on  → <home>/logs/omp.jsonl
  "toolPrefix": "memory_",  // model-facing tool prefix; use "harnmem_" to avoid clashes
  "debug": false
}
```

Environment overrides: `HARNMEM_HOME`, `HARNMEM_DISABLED=1`, `HARNMEM_READONLY=1`, `HARNMEM_INJECT=1|0`, `HARNMEM_STATUS_LINE=1|0`, `HARNMEM_AUTO_EXTRACT=1`, `HARNMEM_DEBUG=1`.

> **Clean footer.** The one-line `harnmem: 22 entries · ~1061 tokens · <sha>` status is
> informational; set `"statusLine": false` in `<agentDir>/harnmem.json` (or
> `HARNMEM_STATUS_LINE=0`) to hide it. Memory injection, tools and extraction are unaffected;
> `/memory status` and the `memory_status` tool still report the snapshot.

> **Tool-name clashes.** If another extension already registers `memory_*` tools, set
> `"toolPrefix": "harnmem_"` in `<agentDir>/harnmem.json` to expose `harnmem_write`,
> `harnmem_search`, `harnmem_read`, `harnmem_forget`, `harnmem_status` instead. The
> `/memory` command keeps its name.

## Tools (model-facing)

| Tool | Parameters | Notes |
|---|---|---|
| `memory_write` | `type` (user/feedback/project/reference), `title`, `description`, `content`, `category`, `scope` (auto/user/project), `importance` (0–10), `confidence` (0–1), `pinned`, `tags`, `entities`, `links`, `supersedes`, `evidence` | Returns one line: `stored … (NEW)` / `already exists … (SKIP)` / `merged into … (MERGE)` / `superseded … → …` / `linked to existing … (LINK)`; registered with `approval: "write"` |
| `memory_search` | `query`, `limit` (8), `scope`, `project`, `include_archived`, `include_history`, `as_of`, `entity`, `debug` | BM25F + synonyms + link diffusion; abstains when not confident; `approval: "read"` |
| `memory_read` | `id`, `as_of`, `include_history` | Frontmatter summary + body + backlinks; `approval: "read"` |
| `memory_forget` | `id`, `hard` | Default moves to `trash/` (30-day grace); `hard` is permanent; `approval: "write"` |
| `memory_status` | — | Shards, index state, health, extraction counters; `approval: "read"` |

`memory_write` marks the snapshot dirty; every successful write refreshes the injected index in the next step.

Tool names follow the `toolPrefix` setting (`memory_` by default); the table above uses the default names.

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

- **Stable snapshot (Option-P):** the context block is appended as a trailing
  `before_agent_start` system-prompt segment and rebuilt only on session start/switch/branch,
  before compaction, after a successful write, and on day rollover. Within a turn stream it is
  byte-identical, so the provider prompt cache — including omp's cache-warming replay, which
  requires byte-identical payloads — is not invalidated.
- **Injection budget:** `maxInjectTokens` (default 1200). Pinned entries first, then
  user/project/digest sections; whole entries only. Body text is never injected — the model
  calls `memory_read` for detail.
- **Resume detection:** omp's `session_start` event carries no reason field; the adapter
  infers `"resume"` from existing conversational entries (the same predicate omp itself uses).
- **Session switches:** `session_before_switch` / `session_before_branch` flush the outgoing
  session's journal under its own id before omp swaps files; `session_switch` / `session_branch`
  re-open state under the new session id.
- **Read-only children:** task/subagent sessions (`ctx.agent.depth > 0` or `kind !== "main"`)
  get no LLM and cannot write: `memory_write failed: HarnMem is read-only`.
- **Session end:** the transcript (last ≤240 messages, assistant truncated) is journaled; when
  `autoExtract` is on, extraction runs at shutdown with a 1.5 s hard timeout (omp gives shutdown
  handlers a ~2 s concurrent budget), ≥3 user messages, and is skipped if the model wrote a
  memory itself that session. Extracted candidates below `confidence 0.5` are dropped; at most
  6 are stored.
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
└── logs/omp.jsonl
```

Plain files are the source of truth: back up or sync `~/.harnmem` directly. The index can always be rebuilt from the Markdown records.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No memory block in context | Empty store (normal); check `/memory status`; check `enabled`/`inject`/`HARNMEM_DISABLED` |
| Write says `HarnMem is read-only` | Subagent session, `readOnly: true`, or `HARNMEM_READONLY=1` |
| `index: ... stale=true` right after a write | Expected: index rebuilds at next session start |
| Extraction reports `failed` | Check LLM availability and `<home>/logs/omp.jsonl` |
| Slow exit (~1.5 s) | Bounded shutdown-extraction wait; disable `autoExtract` if not wanted |
| Plugin loaded but no tools | Check `omp plugin list` / `omp plugin doctor`; `-e` path must point at `dist/index.js` |

## Development

```bash
pnpm --filter @harnmem/core build
pnpm --filter @harnmem/omp-harnmem build   # tsdown bundle + asset vendoring into dist/
pnpm --filter @harnmem/omp-harnmem test    # config unit tests (also runs under the root pnpm test)
```

Source layout: `src/index.ts` (event wiring), `state.ts` (engine lifecycle), `context.ts` (snapshot manager), `tools.ts`, `command.ts`, `llm.ts` (omp model bridge via `completeSimple`), `journal.ts`, `log.ts`, `subagent.ts`, `config.ts`, `format.ts`.

`@oh-my-pi/*` imports stay unbundled on purpose: omp's plugin loader rewrites those
specifiers onto its host-bundled copies before evaluation.

## Limitations

- omp only for this package; other harnesses use their own adapters.
- Config resolution has unit tests (`node --test test/*.test.mjs`); runtime behavior is covered by manual end-to-end runs against omp 18.14.1.
- `autoExtract` extraction window is bounded to 1.5 s at shutdown (omp budget); long transcripts may not fully extract — prefer explicit `memory_write`.
- omp's session_stop event fires per turn settle, so extraction is anchored to `session_shutdown` instead.

## License

MIT
