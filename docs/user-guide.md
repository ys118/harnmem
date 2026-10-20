# HarnMem user guide

Version: v0.1.0 · Updated: 2026-10-20 · Tested with: pi 1.3.0 on Windows 11 (the reference environment); macOS/Linux not yet tested

HarnMem is a **cross-harness long-term memory system**: memories live as plain Markdown in `~/.harnmem`, with zero external services, zero databases, and zero embedding models. The model uses them through an injected "memory index" plus 5 tools.

Labels: **[Verified]** actually ran in this repo; **[Syntax-verified]** the command exists but was not run end to end; **[Not implemented]** designed only, code not usable yet.

---

## 0. What works today

| Host | Status | Notes |
|---|---|---|
| **pi** | ✅ Usable (e2e) | 5 tools + `/memory` command + stable snapshot injection (verified in a real pi 1.3.0 session) |
| **CLI** | ✅ Usable | `@harnmem/cli`, bin `harnmem` (run as `node packages/cli/dist/main.js` from a checkout): stats/search/read/write/forget/restore/consolidate/rebuild/export + migration importers |
| DSH / Claude Code | 📐 Design only | `docs/design/07,08,09`; no packages yet |

Writing memories relies on the model calling `memory_write` explicitly; end-of-session background extraction is **off by default** (§5).

## 1. Installation

Prerequisites: **Node.js 22.15+** (repo-wide baseline — root `engines`, README and CI; CLI migration uses `node:zlib` zstd for session-log cwd recovery), pnpm 10, pi 1.3.0, git (optional; used to identify projects by remote).

```powershell
cd <repo>
pnpm install
pnpm -r build
```

[Verified] `pnpm -r build` builds `@harnmem/core`, `@harnmem/cli`, and `harnmem-pi`; `pnpm test` passes 19/19 (build + `node --test`).

Install into pi (local path):

```powershell
pi install ./packages/harnmem-pi     # -l installs only into the current project's settings
```

[Syntax-verified] (partial) pi 1.3.0 `install --help` supports local paths; install + extension load were verified in an isolated profile (the `settings.json` entry was written and the store initialized), but a full provider turn was not run (no API key available).

Development/debugging (loads the extension directly, without writing pi settings):

```powershell
pi -e ./packages/harnmem-pi/dist/index.js
```

[Verified] A real pi 1.3.0 session exercised empty-store loading, writing, cross-session recall, byte-stable injection, and the read-only subagent path (child marker set programmatically; a real foreground child was not launched).

To confirm: run `/memory status` inside pi; the TUI status bar shows `harnmem v1`, with output like:

```text
harnmem v1 home=C:\Users\<you>\.harnmem project: harnmem-cf7563e555
index: seq=2 stale=true built=- size=1547B overhead=<ratio>
shard user [user] total=1 active=1 superseded=0 archived=0 pinned=0
extraction: pending=0 failed=0
```

npm installation (`pi install npm:harnmem-pi`) has not been published yet.

## 2. First use

Say "from now on this project uses pnpm, not npm"; the model calls `memory_write` and gets a one-line result:

```text
stored mem_xxxxxxxxxxxxxxxxxxxxxxxxxx (NEW)
```

`already exists ... (SKIP)` means mechanical deduplication matched; it is not an error. In the next session, the system prompt gets a stable snapshot appended:

```markdown
## HarnMem memory (cross-harness; stable snapshot)

### Project memories
- [feedback] Dependency management uses pnpm — npm install is forbidden in this project

<!-- SSOT: ~/.harnmem. Use memory_search for details; never invent memory ids. ... -->
```

**An empty store injects nothing (0 bytes)**, so no tokens are wasted.

| What you say | What the model calls | Result |
|---|---|---|
| "What was our dependency policy?" | `memory_search` | A hit list, or `... (abstained)` |
| "Show me the full text" | `memory_read` | Frontmatter summary + body + backlinks |
| "Forget this one" | `memory_forget` (trash for 30 days by default) | `moved mem_xxx to trash` |
| "Delete it permanently" | `memory_forget(hard=true)` | Permanent, unrecoverable |
| Restore manually | `/memory restore <id>` | Restores from trash |

Note: `memory_restore` is **not** a model tool; use the `/memory restore` command instead.

## 3. Where the data lives

Defaults to `~/.harnmem` (Windows: `C:\Users\<you>\.harnmem`); override with `HARNMEM_HOME`:

```text
~/.harnmem/
├── VERSION / config.json / projects.json
├── memories/user/                 # MEMORY.md index + mem_<26 chars>.md records
├── memories/projects/<projectId>/ # Project scope (same structure)
├── index/manifest.json + <shard>.json   # Rebuildable, do not edit by hand
├── digests/<shard>/               # Topic digests (optional)
├── sessions/<YYYY-MM-DD>/         # Session journal (for auto-extraction)
├── state/{seq,audit.jsonl,cursors.json}
├── trash/                         # Recycle bin (30 days by default)
├── logs/pi.jsonl
├── prompts/                       # Prompt assets (editable copy deployed on first open)
└── data/                          # Synonym tables (deployed on first open; delete to fall back to defaults)
```

- **The SSOT is these .md files**: read/grep/back them up with git directly; delete the directory = clear all memories.
- `index/` and `MEMORY.md` are rebuildable and never affect the source records.
- **Project identity**: prefer the normalized git remote (`git:...`), otherwise the absolute path (`path:...`), producing `projectId=<slug>-<first 10 hex of sha1>`; the same remote in a different clone path = the same project.
- **Scope**: `user` is visible across projects; `project` only in the current project. The model decides by default; you can also specify it explicitly.

## 4. Configuration

| Location | Content | Priority |
|---|---|---|
| Built-in defaults | See below | Lowest |
| `<home>/config.json` | Engine config (may also hold plugin fields) | Low |
| `<project root>/.harnmem.json` | Project overrides | Medium |
| `<agentDir>/harnmem.json` | pi plugin settings (default `~/.pi/agent`; honors `PI_CODING_AGENT_DIR`) | High |
| Environment variables | §4.3 | Highest |

JSON may contain comments (`//`, `/* */`); mistakes only produce warnings, never crashes. **Note**: the `injection/search` keys from older design docs are obsolete; this section and `packages/core/src/config.ts` are authoritative.

### 4.1 Engine config (`<home>/config.json`)

```json
{
  "budget": { "injectTokens": 1200, "searchTokens": 1200, "hotEntries": 24, "maxPinned": 10 },
  "retrieval": { "synonyms": true, "ttlDays": { "project": 180 } },
  "write": { "autoExtract": false, "minUserMessages": 3, "skipExtractIfModelWrote": 1,
             "maxPerRun": 6, "minConfidence": 0.5 },
  "governance": { "maxUserRecords": 500, "maxProjectRecords": 3000,
                  "maxBodyBytes": 65536, "trashGraceDays": 30 }
}
```

### 4.2 pi plugin settings (`<agentDir>/harnmem.json`)

```json
{
  "enabled": true, "inject": true, "autoExtract": false, "readOnly": false,
  "home": "D:/harnmem-home",
  "maxInjectTokens": 1200, "maxSearchTokens": 1200,
  "model": { "provider": "<provider>", "id": "<model>",
             "reasoning": "low", "timeoutMs": 60000 },
  "log": "errors", "debug": false
}
```

If `model` is omitted, the current pi session model is used; `log`: `off|errors|on` → `<home>/logs/pi.jsonl`; `debug` records injection hashes and provider request sizes.

### 4.3 Environment variables

`HARNMEM_HOME` (change the root, most common), `HARNMEM_DISABLED=1`, `HARNMEM_READONLY=1`, `HARNMEM_INJECT=1|0`, `HARNMEM_AUTO_EXTRACT=1`, `HARNMEM_DEBUG=1`.

### 4.4 Tuning tips

Save tokens → `injectTokens: 800`; keep more memories → `maxProjectRecords: 6000` (watch latency); read-only use → `HARNMEM_READONLY=1`; isolated testing → `HARNMEM_HOME=D:\tmp\harnmem-test`.

## 5. Auto-extraction (off by default)

When enabled (plugin `autoExtract: true` or `HARNMEM_AUTO_EXTRACT=1`), a background LLM extracts 0–6 durable memories **on a normal exit**. Triggers (all required): at least 3 real user messages this session; the model **did not** write memories by hand this session (`skipExtractIfModelWrote: 1`); an LLM is available; exit waits at most **8 seconds** (gives up on timeout, never blocks exit).

Filtering: `confidence < 0.5` is dropped, at most 6 per run, identical content is skipped.

Prompt assets: the first time the engine opens, it copies the repository's default assets into `<home>/prompts/` and `<home>/data/` (**existing files are never overwritten**; the first copy is shown in the startup log/debug). Every extraction/consolidation then reads these two directories **at call time**, so edits take effect on the next extraction without a restart:

- Extraction: `<home>/prompts/extract.md` (`## system` + `## user` + `{{observation_date}}`/`{{existing_memories}}`/`{{transcript}}`)
- Consolidation: `<home>/prompts/consolidate-digest.md` (`{{topic}}`/`{{memories}}`)
- Synonyms: `<home>/data/synonyms.zh.txt` (`term<TAB>synonym1,synonym2`, also accepts `=`/`:`/`：`/`、`/`，`; one-hop expansion)

Loading priority: the `<home>` copy → the repository/package default → the prompt built into `packages/core`. HTML comments (`<!-- ... -->`) are stripped during parsing and never sent to the model; if a file has no `## system`/`## user` markers, the whole file is used as the system prompt. Format details are in `prompts/README.md`. Delete the `<home>` copy to fall back to the defaults.

## 6. How it works

- **Injection (KV-cache friendly)**: rebuilt only at session start, before compaction, after writing a memory, or across a day boundary; byte-stable within a session. Default **1200 tokens** (configurable 800–2000); pinned memories first, then reweighted fill by `importance/confidence/recency/use count/pin` when over budget. Only "index lines" are injected (type/title/description); **bodies are not injected** — the model calls `memory_read` when it needs details. The snapshot ends with a fixed HTML comment `<!-- SSOT: ~/.harnmem … -->` warning that it may be stale; it **contains no timestamp**, so byte stability is not broken every turn.
- **Tools (5)**:

| Tool | Key parameters | Behavior |
|---|---|---|
| `memory_write` | `type` (user/feedback/project/reference), `title`, `description`, `content`, `scope`, `category`, `importance`, `confidence`, `pinned`, `tags`, `entities`, `links`, `supersedes`, `evidence` | Returns a single line: `stored/skip/merged/superseded/linked` |
| `memory_search` | `query`, `limit` (8), `scope`, `include_archived`, `as_of`, `entity`, `debug` | BM25F hybrid retrieval; `abstained: true` when not confident |
| `memory_read` | `id`, `as_of`, `include_history` | Body + metadata + backlinks |
| `memory_forget` | `id`, `hard` | Trash for 30 days by default |
| `memory_status` | — | Store stats, index state, health checks |

- **`/memory` commands**: `status` / `search <q> [--limit N]` / `read <id> [--history]` / `forget <id> [--hard]` / `restore <id>` / `consolidate [--dry-run] [--mechanical]` / `help`.
- **Subagents are read-only**: in child sessions `memory_write` returns `HarnMem is read-only` and never pollutes the main session.
- **Logs**: `<home>/logs/pi.jsonl` (injection size/hash, tool calls, extraction results, errors).

## 7. Typical scenarios

| Scenario | Example phrasing | Type/scope |
|---|---|---|
| Personal preference | "I always use pnpm; no more npm from now on" | user/feedback, across projects |
| Project decision | "Use better-sqlite3 instead of sqlite3 because the sync API is simpler" | project/decision |
| Pitfall | "On Windows better-sqlite3 needs prebuilt binaries, otherwise install VS Build Tools" | project/pitfall |
| External reference | "Protocol doc https://example.com/spec, section 3" | reference/external |
| Rule change | "We switched to pnpm; the earlier npm note is obsolete" | New memory + `supersedes` the old id (old record kept; query with `as_of`) |
| Keep forever | "Mark this as permanently remembered" | `pinned: true` (pin only when the user explicitly asks) |

## 8. Migration

[Verified] Migration is implemented in the CLI and was verified end-to-end on **read-only copies** of real stores — source files stayed byte-identical (sha256 + mtime unchanged after every run).

```powershell
harnmem import dsh             # dry-run by default (no writes)
harnmem import dsh --apply     # write, back up the source, record a ledger, verify hashes
harnmem import pi --path "~/.pi/agent/memory"
harnmem import zcode --apply   # optional; absent stores are skipped
harnmem import json --path file.json   # ImportRecord[] round-trip
harnmem import list            # recorded runs
harnmem import verify [runId]  # re-read ids + confirm sources untouched
harnmem import rollback [runId]  # hard-forget the ids from one run
harnmem import unresolved      # buckets that could not be attributed
```

When running from a checkout without the `harnmem` bin on PATH, use `node packages/cli/dist/main.js import ...` (the whole project requires Node.js 22.15+, see §1).

Sources and verified results (2026-10-20):

- **dsh**: 28 memories imported (19 project / 5 feedback / 2 reference / 2 user); a second run added 0 and skipped 28 (idempotent); rollback removed all 28 and re-import worked.
- **pi**: 10 user memories from `MEMORY.md` imported; 22 daily entries are unresolved by default (session logs carry no session→cwd mapping) and can be attributed with `--project <id|path>` or `--path-map key=id|path`.
- **zcode**: importer implemented but has not been verified with real data (no ZCode data exists on the test machine).
- **json**: `harnmem import json --path file.json` round-trips `ImportRecord[]`.

Safety: dry-run is the default; `--apply` backs up the source first, writes a ledger, and verifies source mtimes/hashes afterwards. `--path-map` accepts a project id already registered in `<home>/projects.json` or an existing directory path. Do not hand-rewrite `MEMORY.md` files to migrate.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No memory block visible | Empty store (normal, 0 injected) | Write one first; check `size` in `/memory status` |
| Memories exist but are not injected | `HARNMEM_DISABLED=1`/`inject:false`/subagent | Check environment variables and config |
| Said "remember" but nothing was written | The model did not call the tool | Explicitly ask it to call `memory_write`; or turn on autoExtract |
| `HarnMem is read-only` | Subagent/`readOnly`/`HARNMEM_READONLY=1` | Go back to the main session to write |
| `stale=true` | Index awaits rebuild after a write in the same session | Normal; rebuilt in the next session |
| Duplicate memories | Wording differs enough to miss dedupe | Use `supersedes` to replace the old entry |
| Want to see the old wording | Only the new value is injected after a supersede | Call `memory_read` with `as_of <date>` or `include_history` |
| Garbled Chinese in the Windows terminal | Terminal encoding (files are UTF-8) | `chcp 65001` or use Windows Terminal |
| Exit hangs for 8 seconds | Auto-extraction wait cap | Normal; disable autoExtract if unwanted |
| Extraction reports `failed` | Missing API key/timeout/non-JSON reply | Check `logs/pi.jsonl`; switch models or disable extraction |
| provider 400 | Some models do not support `--thinking max` | Use `--thinking low` (a real issue encountered during e2e) |
| `harnmem` not found | The CLI bin is not on PATH | Run the entry point directly from the checkout: `node packages/cli/dist/main.js <command>` |
| Import reports unresolved records | No project attribution (no session→cwd mapping) | Inspect `harnmem import unresolved`, then re-run with `--project <id|path>` and/or `--path-map` |
| Import wrote nothing | Dry-run is the default | Add `--apply`; then confirm with `harnmem import verify <runId>` |

## 10. Backup, privacy, and deletion

- **Backup**: copy `~/.harnmem` directly (plain files, diffable); a private git repo or cloud sync is recommended.
- **Privacy**: extraction prompts are told to skip secrets/passwords; still, do not feed the memory system anything sensitive. The audit log records injection events (not full bodies).
- **Deletion semantics**: `memory_forget` moves to `trash/` by default (purgeable after 30 days); `hard=true` deletes permanently; there is no one-shot clear command — delete the directory to clear everything.
- **Multi-machine sharing**: pointing the same home at a sync drive shares memories across machines; v0.1 does not heavily validate concurrent writes from multiple hosts.

## 11. Known limitations (v0.1)

| Limitation | Notes |
|---|---|
| pi only | DSH / Claude Code have design docs only (`docs/design/07,08,09`); no packages yet |
| CLI | [Verified] usable, including migration on read-only copies (§8); npm not published yet — install from source |
| Auto-extraction off by default | Triggers only on a normal exit, waits at most 8 seconds |
| Prompts/synonyms | An editable copy is deployed on first open (see §5); `write-policy.md` is reference text only and is not injected by the engine yet |
| Retrieval quality | Final eval (2026-10-20, deterministic corpus): functional gates PASS — macro R@10 1.000, MRR 0.891, nDCG@10 0.911; S5 both_recall 1.000, S6 abstain_fp 0.000, S10 write-action accuracy 1.000, S12 injected tokens p95 207. Advisory non-functional gaps: 10k-record import ~12–15 s, index overhead ~47× body-only (2.87× canonical store), S8 cross-lingual P@1 0.225 and S11 top-1 ranking |
| No GUI | Plain files + TUI/CLI, consistent with the "zero services" positioning |

## 12. Quick reference

```text
Build: pnpm install && pnpm -r build      Test: pnpm test
Load in dev: pi -e ./packages/harnmem-pi/dist/index.js
Install: pi install ./packages/harnmem-pi
Isolated environment: $env:HARNMEM_HOME="D:\tmp\harnmem-test"
Store: ~/.harnmem    Logs: <home>/logs/pi.jsonl    Status: /memory status

CLI: node packages/cli/dist/main.js --help   (bin: harnmem once the package is installed)
CLI: harnmem stats | harnmem search "<query>" | harnmem forget <id>
Migration: harnmem import dsh|pi|zcode|json   (dry-run by default; add --apply)
Migration checks: harnmem import list | verify <runId> | rollback <runId> | unresolved
```

Related docs: `README.md` (overview), `docs/design/02-data-model.md` (fields), `docs/design/03-retrieval.md` (retrieval/injection), `packages/harnmem-pi/README.md` (plugin docs).
