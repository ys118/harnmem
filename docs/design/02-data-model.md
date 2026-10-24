# 02 · Data model: SSOT layout, schema, scope, and migration

## 1. Directory layout (`~/.harnmem/`)

```
~/.harnmem/
├── VERSION                          # schema version, e.g. "1"
├── config.json                      # user configuration (see 01 §7)
├── projects.json                    # project identity registry (key → projectId, etc.)
├── memories/                        # ★ SSOT: one .md per memory
│   ├── user/                        # user scope (global)
│   │   ├── mem_01k2p3...md
│   │   └── MEMORY.md                # auto-generated user index (read-only view, rebuildable from files)
│   └── projects/
│       └── example-project-3f9a2c1b7d/
│           ├── mem_01k2p4...md
│           └── MEMORY.md
├── index/                           # derived indexes (delete and rebuild at will)
│   ├── manifest.json                # {version, seq, builtAt, shards[]}
│   ├── user.json                    # one BM25F index file per shard
│   └── example-project-3f9a2c1b7d.json
├── digests/                         # topic-level "standing answer" pages (L1 layer, rewritten by hand/consolidation)
│   └── <project-or-user>/<topic>.md
├── sessions/                        # session logs (extraction source, derived data)
│   ├── 2026-10-20/
│   │   ├── pi_01k2p5....jsonl
│   │   └── dsh_01k2p6....jsonl
│   └── ...
├── state/
│   ├── seq                          # monotonically increasing write sequence (cross-process visibility)
│   ├── cursors.json                 # extraction cursors per harness/session
│   └── audit.jsonl                  # injection/write/merge/archive audit (append-only)
├── trash/                           # soft deletes (forget lands here; restorable)
│   └── <YYYYMMDD>-mem_....md
├── prompts/                         # first-run deploy: editable prompt copies (assets.ts)
├── data/                            # first-run deploy: synonym tables (synonyms.<lang>.txt)
└── logs/                            # adapter logs (e.g. pi.jsonl, created by the adapter)
```

**Implementation status**: `Store.init` (`packages/core/src/store.ts:78-94`) actually creates `memories/user`, `memories/projects`, `state`, `index`, `trash`, `digests`, `sessions`, `prompts`, `data`, and `VERSION`. The directories marked 🅥2 below are **design reservations not created in v1**:

| Reserved (v0.2) | Intended purpose | Status |
|---|---|---|
| `state/queue/` | Extraction job queue (≤3 retries on failure) | Not created; v1 only records a failure in the audit, no retry (04 §3.1) |
| `state/locks/` | Cross-process lock files | Not created; v1 uses `atomicWriteFile` + seq for visibility, with no separate lock directory |
| `conflicts/` | Concurrent-write conflict copies for manual resolution | Not created; v1 handles pinned/conflict cases via `WriteResult.warnings` + bitemporal supersede |
| `archive/` | Archive history (monthly-compressed session logs) | Not created; archiving only changes a record's `status`, files are not moved |

**Design notes**

- `memories/` is the **single source of truth**; `MEMORY.md`, `index/`, and `sessions/` can all be deleted and rebuilt.
- Files are partitioned by **scope**, not by harness — cross-harness sharing is the goal, and each harness only records itself in the `source` metadata.
- Project directory names = **readable slug + stable hash** (see §4), balancing human browsing against stability across renames and machine changes.
- The directory syncs as a whole (OneDrive/git/Syncthing), but **multiple machines writing simultaneously** on a synced drive is not recommended; a single machine is fine.

## 2. Memory file format (`.md`)

One memory = YAML-subset frontmatter + Markdown body.

```markdown
---
schema: 1
id: mem_01k2p3m8q4w7r5t0y2u9v6x4zb
type: project
category: decision
scope: project
project: example-project-3f9a2c1b7d
title: Run the full test suite before committing
description: After changing core modules or pipelines, run `just test` plus the smoke benchmark before committing; any regression above the agreed threshold goes back to the drawing board
tags: [tests, gate, promotion]
entities: [example-project, just]
importance: 9
confidence: 0.9
pinned: true
status: active
created: 1792337217231
updated: 1792421073359
last_used: 1792487631672
used_count: 7
valid_from: 1792337217231
valid_to: null
observed_at: 1792337217231
evidence: 2
source:
  harness: dsh
  session: 0f1e2d3c-4b5a-4c6d-8e9f-0123456789ab
  turn: 42
  ts: 1792421073359
provenance:
  - dsh:0f1e2d3c#42
  - pi:<session-id>#118
links: [mem_01k2p4a1b2c3d4e5f6g7h8j9km, mem_01k2p5n0q1r2s3t4u5v6w7x8yz]
supersedes: []
superseded_by: null
---

Any change — core modules/retrieval logic/data pipeline/config/dependency upgrades/backfills — **must run `just test` + `just bench` before committing**.

Decision rule: if any metric of the smoke benchmark exceeds the baseline by more than the agreed threshold, it counts as a regression and must be fixed or rolled back.

**Why:** accuracy is the only acceptance criterion; a green unit test ≠ no bug.

**How to apply:** before committing, run `just test` then the smoke benchmark, and compare each metric against the baseline.
```

### 2.1 Field specification

| Field | Type | Required | Description |
|---|---|---|---|
| `schema` | int | yes | Data model version, currently `1` |
| `id` | string | yes | `mem_` + 26 Crockford Base32 characters; globally unique, never reused |
| `type` | enum | yes | **Exactly four types**: `user / feedback / project / reference` (matching the type whitelists of dsh-auto-memory, ZCode, and Claude Code for cross-harness interoperability); finer-grained semantics go in `category` |
| `category` | string | no | Free-form short tag, e.g. `decision / convention / lesson / pitfall / state / profile / external`; only affects retrieval weighting and display, never permission semantics |
| `scope` | enum | yes | `user` or `project` |
| `project` | string | required when scope=project | projectId (§4) |
| `title` | string | yes | ≤ 80 characters; shown in the injected index |
| `description` | string | yes | ≤ 200 characters; the one-sentence hook (used for both ranking and injection) |
| `tags` | string[] | no | lowercase, kebab-case; used for filtering and retrieval weighting |
| `importance` | 0–10 | yes | Initial value supplied by the writer (LLM suggestion or heuristic); governance may adjust it later; pinned ignores decay |
| `confidence` | 0–1 | no | Extraction confidence; consulted during conflict resolution |
| `pinned` | bool | yes | Pinned: never auto-archived/merged/forgotten; always included in injection |
| `status` | enum | yes | `active / superseded / archived / dropped` (exactly four values, matching `MemoryStatus` in `packages/core/src/types.ts`; `dropped` = moved into `trash/`) |
| `created` | int(ms) | yes | Creation time |
| `updated` | int(ms) | yes | Time of the last content change |
| `last_used` | int(ms) | no | Last time the memory was retrieved/injected |
| `used_count` | int | no | Cumulative retrieval/injection count (recall feedback) |
| `valid_from` | int(ms) | no | Bitemporal: when the fact **became true in the world** (defaults to `created`). `--as-of <ts>` retrieval filters on it |
| `valid_to` | int(ms) \| null | no | Bitemporal: when the fact **stopped being true**; set to now on supersede, **never deleted** (history remains queryable) |
| `observed_at` | int(ms) | no | When the fact was observed/stated (may differ from created; use the original date when migrating old data) |
| `evidence` | int | no | Number of corroborating references (accumulates when multiple memories on the same topic corroborate each other; only increases) |
| `entities` | string[] | no | Normalized entity names (tools/libraries/repos/files/concepts) for co-occurrence linking and filtering |
| `source` | object | yes | First source: `{harness, session, turn, ts}` |
| `provenance` | string[] | no | Chain of change/merge sources (`harness:session#turn`) |
| `links` | string[] | no | Related memory ids; `[[id]]` references in the body are also parsed into the graph |
| `supersedes` | string[] | no | Old memories that this entry replaces |
| `superseded_by` | string\|null | no | Which entry replaced this one (old entry points at the new one) |
| `sensitive` | bool | no | Set when redaction rules match; not injected by default |
| `migrated_from` | object | no | Migration source: `{system, path, original_id}` |

> Mapping to `packages/core/src/types.ts`: the on-disk frontmatter uses snake_case while the TS `MemoryRecord` uses camelCase (`lastUsed / usedCount / validFrom / validTo / observedAt / supersededBy`, `source.migratedFrom`); fields correspond one-to-one. `projectName` is derived at read time and not persisted; `extra` preserves unknown fields (forward compatibility). `status` has only the four values above; `cooling` does not exist.

**Body conventions** (soft constraints, not enforced):

- The first paragraph states "the one-sentence conclusion + applicability conditions";
- `**Why:**` / `**How to apply:**` for feedback/decision types (following the user's existing habits);
- Evidence, code locations (`file.ts:123`), and external links all live in the body; writing them out fully is encouraged;
- `[[mem_id]]` creates bidirectional links, used for clustering during `consolidate`.

### 2.2 YAML subset (self-implemented parser, zero dependencies)

Only the subset we generate or need users to hand-edit is supported; **full YAML is not implemented**:

- `key: scalar` (unquoted values are preserved verbatim; double-quote values containing `:` or `#`)
- `key: "string"` / `key: 'string'` (supports `\"` escapes)
- `key: [a, b, c]` (inline array; values may be quoted)
- `key:` followed by a newline and two-space-indented `- item` (block array)
- One level of nested map: two-space-indented `k: v`
- `#` comments (whole lines only; no end-of-line comments, to avoid mangling URLs)
- `null` / `true` / `false` / integers / decimals auto-detected

The writer only emits the **normalized** form: fields in a fixed order, arrays inline, strings unquoted where unnecessary. The parser is **lenient**: unknown fields are preserved verbatim (forward compatibility); on parse failure the raw body is preserved and reported by `doctor`.

## 3. Scope and project identity

### 3.1 Scope rules

| Nature of the content | scope |
|---|---|
| User identity, preferences, communication/work habits, cross-project red lines | `user` |
| Project architecture, decisions, conventions, pitfalls, data/config facts | `project` |
| Unsure | Default to `project` (avoid global noise); if the user explicitly says "always do this from now on" → `user` |

### 3.2 projectId computation (the key to cross-harness stability)

```
Input: cwd (the session working directory)
1) Find the git repository root:
   - Walk up looking for .git (directory or file; a worktree's .git is "gitdir: ...")
   - If .git is a file → read the real gitdir it points to, then read its config
2) Read remotes: prefer origin, otherwise any remote
   - Normalize: strip scheme/credentials/port → host/path (lowercase host, drop .git suffix, drop trailing slash)
   - Example: git@github.com:acme/example-project.git → github.com/acme/example-project
3) key = "git:" + normalized URL
   No git/remote → key = "path:" + normalize(absPath)
     normalize: lowercase (Windows), convert separators to '/', drop trailing slash; normalize drive-letter case
4) projectId = slug + "-" + sha1(key)[:10]
   slug: repo name or directory name → ASCII kebab-case; non-ASCII falls back to "p"
   Example: github.com/acme/example-project → example-project-3f9a2c1b7d
   Example: path:~/projects/example-project → p-8c2e1b4a90
5) Register in projects.json (key → {projectId, slug, name, paths[], created, updated})
```

**Why git remote rather than the path**: the projectId survives worktrees, directory changes, and repository moves; worktrees of the same repository share project memory (matching the user's worktree+PR workflow).

**Subdirectories inside a project** do not get their own scope; when needed, express them with `tags` (e.g. `module:backend`).

### 3.3 `projects.json`

```jsonc
{
  "version": 1,
  "projects": {
    "git:github.com/acme/example-project": {
      "id": "example-project-3f9a2c1b7d",
      "slug": "example-project",
      "name": "Example Project",
      "paths": ["~/projects/example-project"],
      "harnesses": ["dsh", "pi"],
      "created": 1792337000000,
      "updated": 1792487000000
    }
  }
}
```

## 4. Index and state files

### 4.1 `index/manifest.json`

```jsonc
{ "version": 1, "seq": 1287, "builtAt": 1792487632000, "shards": ["user", "example-project-3f9a2c1b7d"], "docs": 1832 }
```

- When `seq` matches `state/seq`, the index is current; otherwise → incremental update.
- Each shard file (`ShardIndexJson` in `packages/core/src/indexer.ts`): `{version:1, name, seq, builtAt, docs:[{id,title,description,type,tags,scope,status,importance,confidence,pinned,created,updated,lastUsed,usedCount,project,...}], docLens:number[], avgLen:number, docTerms:string[][], postings:{term:[[docIdx, weight], ...]}}`.
- **The hot index used for injection is not persisted**: in v1 `retrieval.ts` computes it from the in-memory index on every `ensureContext` (pinned first → the rest sorted by contextScore → budget fill); `index/hot/<shard>.json` is reserved for v0.2 (to reuse across processes and to aid debugging) and is not created in v1.
- Incremental updates: after a write/modify, `index.get(shard)` validates `manifest.seq` against the file's `seq`; a mismatch or version mismatch → full rebuild of that shard and write-back of the manifest; `state/dirty/` is reserved for v0.2 and not created in v1.

### 4.2 `state/audit.jsonl` (append-only)

```jsonc
{"seq":1288,"ts":1792487632100,"kind":"inject","harness":"pi","session":"01a0...","ids":["mem_...","mem_..."],"bytes":2106}
{"seq":1289,"ts":1792487632200,"kind":"write","harness":"dsh","action":"supersede","id":"mem_...","superseded":["mem_..."]}
{"seq":1290,"ts":1792487632300,"kind":"consolidate","merged":["mem_a","mem_b"],"into":"mem_c","reason":"near-dup"}
{"seq":1291,"ts":1792487632400,"kind":"archive","ids":["mem_x"],"reason":"decayed"}
```

### 4.3 `sessions/<YYYY-MM-DD>/<harness>_<sessionId>.jsonl`

```jsonc
{"ts":1792487500000,"role":"user","text":"..."}
{"ts":1792487510000,"role":"assistant","text":"..."}
{"ts":1792487520000,"role":"tool","name":"memory_search","argsHash":"..."}
```

- Stores only the summaries/excerpts "needed for extraction" (default: last 200 turns, 2KB per entry), not the full transcript;
- After extraction, these can be compressed or expired (30 days of hot data retained by default).

## 5. Migration mapping (existing data → unified format)

### 5.1 dsh-auto-memory (`~/.dsh/memory/`)

| Existing | Unified format |
|---|---|
| `_user/*.md` | `memories/user/*.md`; the four-type taxonomy is preserved (user/feedback/project/reference); legacy `project` files in the global directory move to user scope with the type unchanged |
| `--home-user-projects-example-predict--/*.md` | Decode the directory name into a candidate path → recompute projectId per §3.2; on failure use `legacy:dsh:<slug>` |
| DSH `MEMORY.md` index lines | Discard (regenerated; only the id mapping is kept) |
| frontmatter `importance/created/updated/lastRead/reads` | Map verbatim to importance/created/updated/last_used/used_count |
| `type: user/feedback/project/reference` | One-to-one mapping, no reclassification; `valid_from/observed_at` take `created` |
| `pinned` | Verbatim; `audit.jsonl` | Discard or archive (not migrated) |

### 5.2 pi-memory (`~/.pi/agent/memory/`)

| Existing | Unified format |
|---|---|
| `MEMORY.md`'s `<!-- date [hash] -->` blocks | One memory per block, type=`project`, category=`note` (blocks with `#tag` infer category from the tag), `source={harness:pi}`, `observed_at=block date` |
| `#rule/#preference/#lesson` tags inside a block | → tags + inferred type (rule/preference→preference, lesson→note/decision) |
| `daily/*.md` | Migrate as session logs (`sessions/`), not directly as memories (avoids noise) |
| `SCRATCHPAD.md` | Discard (session state) |
| `recovery/` | Discard |

### 5.3 ZCode (`~/.zcode/cli/memories/projects/<slug>-<sha256[:16]>/memory/`)

| Existing | Unified format |
|---|---|
| `MEMORY.md` index | Discard, regenerate |
| Topic `.md` files (frontmatter name/description/metadata.type) | Migrate each one: name→title, description→description, type whitelist mapping |
| `dream/` | Ignore (not enabled) |

**Migration principles**: idempotent (repeated runs do not create duplicates); keep the original file path in `migrated_from`; support `--dry-run`; leave the source directories untouched after migration (zero rollback cost); emit `migrate-report.md` (counts/dedup/conflicts/failure details).

## 6. Boundary with "standing instruction files"

- `AGENTS.md` / `CLAUDE.md` / `~/.pi/agent/AGENTS.md` are **stable, strong constraints** maintained by the user; harnmem **never rewrites them automatically**.
- harnmem owns "facts and experience recalled on demand"; when the two conflict, the instruction files win (this rule is written explicitly into the extraction prompt).
- Optional capability (later version): `harnmem export --agents-md` produces a "memory snapshot" fragment for the user to paste manually; never modify anything automatically.

## 7. Versioning and evolution

- The `schema` field + the `VERSION` file; reading old-version files is **forward-compatible** (unknown fields preserved, missing fields filled with defaults).
- Breaking changes → explicitly run `harnmem doctor --migrate-schema`, after backing up to `memories.bak/`.
- Index/manifest versions are independent; on mismatch the index is simply rebuilt (no data migration needed).
