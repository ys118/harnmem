# 10 · Migration onboarding: one command for every legacy memory store

> Version: v1 (2026-10-25), design of record for the migration-onboarding work (ROADMAP
> N14). Scope: the `@harnmem/cli` `import` surface plus one prompt asset; **no core
> changes, no new dependencies, no network**. Status line: *implemented 2026-10-25 —
> see "Implementation status" in §11*.
> Evidence levels used below: **✅ verified in this repository** (the code path exists and is
> covered by tests or a recorded run), **△ designed** (agreed here, implemented in the same
> release), **? unverified** (no real store of that shape exists on the development machine).

The existing importers (`import dsh|pi|zcode|json`) already implement the expensive half of
migration: discovery, dry-run planning, source backup + sha256 manifest, ledger-based
idempotency, post-apply verification, and per-run rollback. This document adds the missing
onboarding half — a path for *unknown* legacy systems — without writing one parser per
product.

## 1. Problem and design principles

A new user installs HarnMem and has memories somewhere else: another harness
(pi / DSH / ZCode / Claude Code), a note vault (Obsidian, `memory-bank/`, plain
`notes/`), an app export (`mem0` JSON, a ChatGPT dump), or a chat transcript. Today the
CLI only helps if the user already knows which subcommand applies, and `import json`
refuses real-world exports (strict four-type enum, required `title`, one bad record
aborts the file).

Design principles, derived from the existing migration guarantees (✅
`packages/cli/src/pipeline.ts:1-14`, `docs/user-guide.md` §8):

1. **Migration moves conclusions, not prose.** HarnMem injects one index line per memory
   (type + title + description, budgeted); a migrated 200 KB note is retrieval noise.
   Every importer must produce short, self-contained memories, and the agent recipe (§8)
   is explicitly told to summarize rules, decisions and pitfalls rather than copy text.
2. **Deterministic where a format is stable; AI where it is not.** File-shaped stores get
   deterministic parsers. Long-tail formats go through a general JSON contract filled by
   the user's own agent. No new product-specific parsers.
3. **Nothing is lost silently.** Records that cannot be typed, titled or attributed are
   reported (`warnings`, `unresolved` buckets), never dropped on the floor.
4. **The safety model does not change.** Dry-run by default; sources are read-only and
   backed up before writes; idempotent via ledger keys; every run is independently
   verifiable and reversible.
5. **Zero dependencies, small surface.** Everything extends the existing
   `ImportSource`/`discover*` pattern. No database drivers, no HTTP clients, no SDKs.

## 2. Current surface and the gap

| Command (✅ exists) | Covers | Limitation |
|---|---|---|
| `import dsh` | `~/.dsh/memory` + session cwd recovery | only DSH |
| `import pi` | `~/.pi/agent/memory` (blocks + `daily/`) | only pi |
| `import zcode` | `~/.zcode/cli/projects/**/memory` | slug dirs need recovery |
| `import json --path <file>` | `ImportRecord[]` round-trip / `harnmem export` | strict schema, JSON only, one bad record aborts |
| `import verify/rollback/list/unresolved` | run-level inspection | unchanged |

What a new user actually hits:

| Gap | Today | This design |
|---|---|---|
| Their harness is absent from the list | no entry point | `import md` (§5), `import claude` (§6), `import auto` (§7) |
| Their app exports JSON that is *not* `ImportRecord[]` | error, abort | relaxed contract with aliases, inference, JSONL and stdin (§4) |
| Their data is unstructured (chat logs, OCR, a cloud dump) | nothing | `prompts/migrate.md` + `import json` recipe (§8) |
| They do not know where their old store lives | must pass `--path-map` | `import auto` scans known stores and prints a plan (§7) |
| They want "just do it" | four commands to discover | `harnmem import auto --apply` one-liner (§7) |

## 3. Three layers

```
                 ┌────────────────────────── long tail ──────────────────────────┐
                 │  chat logs · screenshots · cloud exports · unknown formats     │
                 │  → user's agent + prompts/migrate.md → ImportRecord JSON       │
                 └───────────────────────────────┬───────────────────────────────┘
                                                 ▼
  known stores ──► deterministic importers ──► universal JSON contract ──► pipeline
  (dsh/pi/zcode/  (md trees, Claude Code,       (relaxed `import json`:    (dry-run,
   claude)         auto scanner)                 aliases, JSONL, stdin)    backup,
                                                                           ledger,
                                                                           verify,
                                                                           rollback)
```

| Layer | Artifact | Purpose |
|---|---|---|
| L1 contract | `importers/json.ts` + `import json` | universal boundary: anything that can emit JSON/JSONL can enter |
| L2 determinism | `importers/md.ts`, `importers/claude.ts`, `import auto` | cover the formats we can parse reliably, and find them automatically |
| L3 fallback | `prompts/migrate.md` + user-guide recipe | extract conclusions from any material using the user's own model |

Only L2 adds code that writes to the store; L1 is the contract every layer (and every
future community script) targets; L3 is prompt + documentation.

## 4. L1 — relaxed `harnmem import json`

### 4.1 Accepted inputs

Priority is: explicit flag > file extension > content sniffing.

| Input form | How | Notes |
|---|---|---|
| `ImportRecord[]` | default | unchanged, still the lossless path |
| envelope object | `{records\|memories\|data\|results\|items: [...]}`, optional `version`/`kind`/`exportedAt` | typical app exports |
| JSONL / NDJSON | `--jsonl`, or `.jsonl`/`.ndjson` extension, or full-file `JSON.parse` fails and every non-empty line parses | one record per line; blank lines and lines starting with `//` skipped |
| stdin | `--path -` | read to EOF; dry-run materializes an OS temp file (removed after the run), `--apply` keeps a copy under `<home>/imports/incoming/stdin-<ts>.json` so backup/verify stay meaningful. Only `import json` accepts `-` |
| single object | `--single` (optional, not required by v1) | deferred: an object that is not an envelope is a usage error |

`{version:1, kind:"harnmem-export", ...}` keeps working (✅ `commands.ts`
`exportRecords`).

### 4.2 Field aliases (first match wins; top level > `metadata.*`)

| Canonical (`ImportRecord`) | Accepted aliases |
|---|---|
| `title` | `name`, `subject`, `heading`, `label` |
| `description` | `summary`, `desc`, `abstract` |
| `content` | `text`, `memory`, `body`, `note`, `value` |
| `type` | `type`, `memory_type`, `metadata.type`, `kind` (only when it names a valid type) |
| `scope` | `scope`, `level` (`user`\|`project`) |
| `project` | `project`, `project_id`, `projectId` |
| `category` | `category`, `topic`, `domain`, `area` |
| `tags` | `tags`, `keywords`, `labels`, `categories` (string or array; split on `,` `/` `#`) |
| `entities` | `entities`, `people`, `subjects` |
| `importance` | `importance`, `weight`, `priority`, `salience`, `relevance`, `score` |
| `confidence` | `confidence`, `certainty` |
| `pinned` | `pinned`, `pin`, `starred`, `favorite` |
| `created` | `created`, `created_at`, `createdAt`, `create_time`, `date`, `timestamp`, `ts` |
| `updated` | `updated`, `updated_at`, `updatedAt`, `modified`, `last_modified`, `mtime` |
| `lastUsed` | `last_used`, `lastUsed`, `lastUsedAt`, `accessed_at`, `accessed` |
| `usedCount` | `used_count`, `usedCount`, `access_count` |
| `links` | `links`, `related`, `relations`, `references`, `refs`, `see_also` |
| `supersedes` | `supersedes`, `replaces` |
| `sensitive` | `sensitive`, `private`, `secret` |
| `id` | `id`, `uuid`, `uid`, `memory_id` (kept only with the `mem_` prefix, as today) |

Nested `metadata` objects are flattened one level (Obsidian/Claude frontmatter style) and
used only for fields that are missing at top level. Unknown fields are ignored (they are
not copied into `extra`, to keep imports predictable; `extra` is honored only if the input
already has a valid `extra` object).

### 4.3 Inference rules

Applied per record, in order; a record is never rejected for a missing field that can be
derived:

1. **type**: explicit value → accepted aliases for legacy types (`decision`→`project`,
   `rule`/`preference`/`workflow`→`feedback`, `lesson`/`pitfall`/`tooling`→`reference`,
   `user`/`profile`→`user`; reuse `typeFromLegacyTags` per tag) → infer from `tags` →
   `scope==="user"` → `reference`.
2. **title**: alias → first Markdown heading in `content` → first non-empty line of
   `content`, stripped and truncated to 80 → record with no derivable title is collected
   into the unresolved bucket (never silently dropped, never aborts the file).
3. **description**: alias → first prose line of `content` stripped/truncated to 200 →
   empty string.
4. **content**: alias; non-string values are `JSON.stringify`ed; truncated to 60 000 chars
   with a warning.
5. **scope**: explicit valid value → `user` when type is `user`, else `project`.
6. **project**: kept only for project scope. A valid `PROJECT_ID_RE` id is trusted;
   otherwise the global `--project` fallback; otherwise the record goes to the unresolved
   bucket (same rule as today, ✅ `importers/json.ts`).
7. **importance**: `score`/`relevance`/`salience`/`weight` values in `(0,1]` are treated as
   normalized and rounded ×10; everything else is rounded and clamped to `0..10`.
8. **timestamps**: `parseLegacyTimestamp` (epoch s/ms, ISO, `YYYY-MM-DD[ HH:mm[:ss]]`,
   numeric strings — ✅ `importers/types.ts:159`).

### 4.4 Error policy

| Failure | Behavior |
|---|---|
| file is not valid JSON/JSONL at all | `UsageError` (exit 2): nothing can be planned |
| a line/record is not an object, or has irrecoverable fields | collected into an unresolved group `invalid:<file>`, one entry per record with the reason; other records still import |
| record lacks title *and* content | unresolved (`reason: missing title and content`) |
| `--apply` returns fewer ids than records | already recorded as errors/warnings by the pipeline (✅ `pipeline.ts:417-441`) |

`counts.errors` stays reserved for persistence failures; rejected-by-contract records are
`unresolved`, so dry-run output shows exactly where they went.

### 4.5 Idempotency and provenance

`originalId` = the input `id`/`uuid` when a string, else `idx-<n>` (stable for a stable
export ordering). Key = `makeKey("json", <path>, originalId)` (✅ `types.ts:193`).
stdin runs key on `-` plus the same `originalId`, so a re-piped identical export skips.
Provenance defaults to `json:<path>`; `source.migratedFrom` defaults to
`{system:"harnmem-json", path, originalId}`. Dry-run and apply use the identical
normalization, so a reviewed dry-run report is what apply writes.

## 5. L2a — `harnmem import md --path <dir|file>`

Generic Markdown-tree importer: Obsidian vaults, `memory-bank/`, `docs/adr/`, note
directories, text dumps.

```text
harnmem import md --path <dir|file> [--mode file|heading] [--max-files 5000]
                  [--include-all] [--apply]
```

### 5.1 Walk rules

- Extensions: `.md`, `.mdx`, `.mdc`, `.markdown`, `.txt`; case-insensitive.
- Skip directories: `.git`, `.hg`, `.svn`, `node_modules`, `dist`, `build`, `out`,
  `.next`, `.venv`, `venv`, `__pycache__`, `target`, `.obsidian`, `.trash`,
  `.harnmem` (never re-import the store).
- Skip files by default (§5.6) and report them in one warning with a count.
- Hard cap `--max-files` (default 5000, same order as the pipeline cap) → `UsageError`
  telling the user to narrow `--path`.
- A file path may be passed directly; a single-file import has one record per mode.

### 5.2 Modes

| Mode | Split | `originalId` |
|---|---|---|
| `file` (default) | one record per file; frontmatter and body are the record | `file:<relpath>` |
| `heading` | split on `^#{1,2} ` outside fenced code blocks; each section is a record; text before the first heading becomes one record when non-empty | `heading:<relpath>#<slug(heading)>` (preamble: `#preamble`) |

- In `heading` mode the heading line is removed from `content` and becomes `title`
  (truncated to 80); a file with no eligible heading falls back to `file` mode.
- Content is capped at 60 000 chars per record (warning + truncation), so a giant note
  still imports.
- Fenced code blocks are never split.

### 5.3 Field mapping

| Source | Mapping |
|---|---|
| frontmatter `title` / `name` / `subject` | `title` |
| frontmatter `description` / `summary` / `desc` | `description` |
| frontmatter `type` / `metadata.type` | `type` via declared-type mapping (§5.4) |
| frontmatter `tags` / `keywords` / `categories` | `tags` (string or array), plus `#hashtags` from the body |
| frontmatter `created` / `date` / `created_at` | `created` |
| frontmatter `updated` / `modified` | `updated` |
| frontmatter `importance` / `priority` | `importance` |
| frontmatter `pinned` / `star` | `pinned` |
| frontmatter `project` / `project_id` | `project` (used only when a valid id) |
| frontmatter `scope` | `scope` (`user` needs no project) |
| frontmatter `links` / `related` or body `[[wiki links]]` | `links` (pipeline remaps them to imported ids, ✅ `pipeline.ts:308-381`) |
| other unknown frontmatter keys | preserved in `extra.frontmatter` |

Title fallback order: frontmatter → first heading in the body → first prose line → humanized
file stem (strip leading `YYYY-MM-DD[-_ ]`, replace `[-_]` with spaces). Description
fallback: frontmatter → first prose line of the body. Content: body without frontmatter
(and without the heading in `heading` mode).

### 5.4 Type inference

1. declarative value (frontmatter `type`/`metadata.type`): reuse the closed mapping —
   `decision`/`adr`/`项目`/`决策`→`project`; `rule`/`preference`/`workflow`/`convention`/
   `policy`/`规则`/`偏好`/`红线`→`feedback`; `lesson`/`pitfall`/`tooling`/`troubleshoot`/
   `教训`/`坑`→`reference`; `user`/`profile`/`用户`→`user`; `feedback`/`reference`/
   `project` pass through (✅ `types.ts:140-151` extended by an `adr`/`convention`/`policy`
   row);
2. tags via `typeFromLegacyTags`;
3. path hints, first segment match: `decisions/`, `adr/`, `rfcs/`→`project`;
   `rules/`, `policies/`, `conventions/`, `preferences/`→`feedback`;
   `lessons/`, `pitfalls/`, `troubleshooting/`, `notes/`→`reference`;
   `profile/`, `user/`, `about/`→`user`;
4. default `reference`.

Every inferred type is visible in the dry-run `by type` line; a wrong guess is fixed by a
source re-run with frontmatter rather than by silent heuristics.

### 5.5 Scope and project attribution

Priority (first hit wins):

1. frontmatter `scope` (`user` → done, no project needed);
2. frontmatter `project` when it matches `PROJECT_ID_RE` (trusted, valid for the store);
3. git repository root above the file (`findGitRepoRoot` equivalent: nearest `.git` dir or
   file): `detectProject(root)` + `registerProject(home, info, "cli")`, cached per root —
   the project id is the same one `harnmem write`/hosts would compute (✅ `identity.ts:143`);
4. `--project <id|path>` fallback (existing global flag);
5. otherwise **user scope** with a warning naming the directory and suggesting
   `--project`, so "no repository" never fabricates a project.

Attribution never silently downgrades a record to the user scope: the warning is counted
in the report, and the recipe in §12 shows the `--project` fix.

### 5.6 Skipped files by default

Host instruction files and memory indexes are not memories: the host injects
`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`.cursorrules`/`.windsurfrules`/`.clinerules`
directly, and `MEMORY.md` is another harness's index — importing them double-injects the
same text or duplicates the index. `--include-all` imports them anyway (for users
decommissioning another harness in the same commit).

### 5.7 Idempotency and provenance

- `harness = "md"`; key = `makeKey("md", relpath, originalId)`; `source.harness = "md"`;
  `source.migratedFrom = {system:"markdown", path, originalId}`;
  `provenance = ["md:<relpath>"]`; `extra.legacy = {mode, heading?}`.
- Same file + same heading anchor + same content → hash matches → skipped on the second
  run (✅ ledger index behavior). Editing a heading changes its `originalId` and imports a
  new record; the old one stays in the store (rollback the run to retire it).
- The source tree is read-only (`--apply` backs it up first, ✅ `pipeline.ts:409-412`).

## 6. L2b — `harnmem import claude`

Claude Code's on-disk memory (`~/.claude`) is structurally the same shape as ZCode
(a per-project directory of Markdown files with `name` / `description` /
`metadata.type` frontmatter), and the dsh plugin's own migration notes recorded the exact
layout and the cwd-recovery trick (✅ `docs/research/dsh-plugin-and-migration.md:476`,
`lib/index.js:1883-2135` of `dsh-auto-memory`). So this is a small parser, not a new
subsystem.

```text
harnmem import claude [--path <dir>] [--apply]
```

- Default root: `$CLAUDE_CONFIG_DIR` or `~/.claude`.
- Records: `<root>/projects/<project-slug>/{*.md, memory/*.md}` (skip `MEMORY.md`), plus
  the legacy `<root>/memory/*.md` tree.
- Project attribution: `--path-map` → `<root>/projects/<slug>/*.jsonl` cwd recovery
  (first 262 144 bytes, newline-delimited JSON, first record carrying a `.cwd` string;
  new helper `readClaudeSessionCwds` in `session-cwd.ts`) → `--project` fallback →
  unresolved bucket. Legacy `<root>/memory/` records are user scope by definition.
- Mapping: title = frontmatter `name`/`title` → first H1 → stem; type =
  `metadata.type` via §5.4 → tags → `reference`; description = frontmatter or first prose
  line; created = `metadata.created`/`metadata.modified`; links = wiki links; body =
  content. `harness = "claude"`, `migratedFrom.system = "claude-code"`.
- `MEMORY.md` is parsed for title/description overrides only (same treatment as the DSH
  importer) and is never imported as a record.
- The Claude Code adapter itself (`design/09`) does not have to exist for this importer:
  migration writes into `~/.harnmem` and the user can keep using whichever harness they
  already have.

## 7. L2c — `harnmem import auto`

The onboarding one-liner. It probes *known memory stores only* and runs the existing
deterministic importers.

```text
harnmem import auto                 # probe + plan (dry-run)
harnmem import auto --apply         # TTY: y/N confirmation; non-TTY: requires --yes
harnmem import auto --apply --yes   # scripted one-shot
```

### 7.1 Probe table (exhaustive; nothing else is scanned)

| Source | Path (env override) | Considered present when |
|---|---|---|
| `dsh` | `$DSH_HOME/memory` (`~/.dsh`) | the dir exists and contains ≥1 entry |
| `pi` | `$PI_AGENT_DIR/memory` (`~/.pi/agent`) | `MEMORY.md` or `daily/` exists |
| `zcode` | `$ZCODE_HOME/cli` (`~/.zcode`) | `locateZcodeRoot` finds `projects/` with a `memory/` child |
| `claude` | `$CLAUDE_CONFIG_DIR` or `~/.claude` | `projects/` or `memory/` contains Markdown |

Deliberately **not** auto-scanned: repository instruction files (`CLAUDE.md`,
`AGENTS.md`, …), editor rule files, SQLite databases, cloud APIs, and arbitrary
directories. Those enter through `--path` (§5) or the agent recipe (§8). Auto must be
predictable: the same machine must plan the same sources every time.

### 7.2 Flow

1. Probe every row; run `discover` for each present store (no writes).
2. Print one plan table: `source | path | discovered | by type | projects | unresolved`,
   then a totals line. `--json` returns the same structure.
3. Without `--apply`: exit 0. This is the review step.
4. With `--apply`: in a TTY ask exactly one `y/N` question (default N) using
   `node:readline`; in a non-TTY require `--yes` (otherwise `UsageError`, so a piping
   script can never trigger a write accidentally).
5. Run `runImport` per source **sequentially**, each with its own `runId`, backup,
   ledger and unresolved buckets → selective `harnmem import rollback <runId>` per
   source. Print each report (`printImportReport`) under its source header, then a
   totals line.
6. Exit code: `FAIL` if any source reported errors or failed verification, else `OK`.
   A source that vanished between probe and apply is reported and skipped, not fatal.

`--from auto` is accepted as the long form, consistent with the other sources.

### 7.3 Why a separate command rather than scanning inside each node

Per-source ledgers keep rollback and verification meaningful ("remove the Claude
import"), keep `import verify` output interpretable, and keep the existing per-source
commands intact for users who prefer explicit control. `auto` is a *dispatcher*: it adds
no new record-level logic.

## 8. L3 — agent-assisted migration (`prompts/migrate.md`)

Anything the deterministic layer cannot ingest (cloud exports, chat transcripts, OCR,
proprietary databases) is handed to the user's own agent. This is the highest-quality
path because a model can summarize conclusions, which is exactly what should be stored.

Recipe:

```text
harnmem stats                                  # also deploys prompts/ into <home>/prompts/
# then tell your agent:
#   Read ~/.harnmem/prompts/migrate.md, then migrate my old memories from <path or service>.
# the agent writes candidate records to a temp JSON file and runs:
harnmem import json --path <tmp>/migrated.json --apply
harnmem import verify <runId>
```

`prompts/migrate.md` contract (deployed automatically by the existing
`deployDefaultAssets` — ✅ `packages/core/src/assets.ts:203`, no core change):

- `## system`: you are a memory migration assistant; your job is to turn an old memory
  store into HarnMem `ImportRecord`s, not to copy documents.
- `## user` template with `{{source}}`, `{{target_home}}`, `{{harnmem}}` placeholders
  (documented, not engine-filled; the agent substitutes them).
- Hard rules: one record per *rule, decision, preference, pitfall or stable fact*
  (target 10–200 per store, not thousands); `title` ≤80 chars; `description` ≤200 chars
  and self-contained (it is the index line); `content` ≤2–4 KB with the why/how to apply;
  `type` ∈ four values; `scope` user vs project; `project` only when known; keep the
  original language; never invent facts, mark uncertainty in `description`; drop
  credentials/personal data or set `sensitive: true`; if the store is huge, migrate in
  batches and re-run (ledger keeps it idempotent).
- Output: a JSON array only, written to the given temp path, then run the two commands
  above and report the dry-run/applied counts. On errors, fix the file — never disable
  the dry-run default by editing the store by hand.

The prompt asset is documentation-grade, not engine-loaded: `prompts/README.md` lists it
with the other assets, and user-guide §8 links to it.

## 9. Explicitly not doing (v1)

- **Per-product connectors** for `mem0`, Letta, Cursor/Windsurf internal SQLite, cloud
  APIs. Format drift makes them a maintenance tax; their exports go through L1/L3.
  (`node:sqlite` exists on Node ≥22 and a local reader can be added later without new
  dependencies if a real user needs it.)
- **`import llm`** (engine-side extraction of raw transcripts). It needs a user-supplied
  endpoint and duplicates what §8 already achieves with the agent the user is talking to.
  Revisit post-v1 if agent-mediated migration proves insufficient.
- **Auto-migrating project instruction files** (`CLAUDE.md`, `AGENTS.md`, rule files).
  Hosts inject them natively; importing them creates duplicate injection and stale copies.
  Explicit `import md --include-all` remains available.
- **Writing back to legacy stores or two-way sync.** One-way, read-only sources, as today.
- **OCR/PDF/HTML parsing.** The agent recipe covers those sources.

## 10. Safety, attribution, idempotency

| Concern | Mechanism |
|---|---|
| Accidental writes | dry-run default everywhere; `auto --apply` additionally confirms in a TTY and refuses a non-TTY without `--yes` |
| Source mutation | sources are only read; `--apply` backs up the tree + sha256/mtime manifest and re-checks afterwards (✅ `pipeline.ts`) |
| Double imports | ledger key `harness\|relativePath\|originalId` + source hash; second run imports 0, changed sources re-import with a warning |
| Misattributed projects | path-map → session-cwd → git root → `--project`; otherwise unresolved/user-scope **with a warning** — never a silent wrong project |
| Duplicates across sources | the same concept imported from two stores stays two memories; the user resolves with `harnmem consolidate` / `supersedes`; migration does not guess sameness |
| Reversal | every run has its own ledger; `import rollback <runId>` hard-forgets exactly that run |
| Limits | 5000 files (`--max-files` overrides the md walker), 60 000 chars/record, 262 144 bytes of session-log header scan, no network |
| Secrets | importers copy what the store contains; `sensitive` is honored; the agent prompt tells the model to drop or flag credentials/PII |

Note (existing behavior, unchanged): dry-run may update the advisory
`<home>/projects.json` registry when the attribution chain registers a git/path project;
it never writes memories, indexes, ledgers, backups or unresolved buckets.

## 11. Implementation plan

| Phase | Work | Files | Est. LOC |
|---|---|---|---|
| P1 | Relaxed JSON contract: aliases, JSONL, stdin, inference, per-record unresolved; `--jsonl` flag; stdin materialization | `importers/json.ts`, `importers/types.ts` (helpers), `commands.ts`, `main.ts` | ~300 |
| P2 | Markdown tree importer (`import md`): walker, modes, mapping, attribution, skips | `importers/md.ts`, `pipeline.ts`, `commands.ts`, `main.ts` | ~450 |
| P3 | Claude Code importer (`import claude`): parser + cwd recovery | `importers/claude.ts`, `session-cwd.ts`, `pipeline.ts`, `commands.ts` | ~250 |
| P4 | `import auto`: probe table, plan table, confirmation, per-source runs, totals | `commands.ts`, `main.ts` | ~250 |
| P5 | Agent prompt + docs: `prompts/migrate.md`, `prompts/README.md`, user-guide §8, CLI README, design index, ROADMAP/CHANGELOG | `prompts/*`, `docs/*`, `README`s | docs |
| P6 | Tests + CI: `packages/cli/test/*.test.mjs` (node:test), CLI `test` script, root `test` script includes CLI, CI unchanged | `packages/cli/{package.json,test/}`, root `package.json` | ~500 |

Constraints for every phase: `pnpm -r build`, `pnpm -r typecheck`, `pnpm test` green; zero
new dependencies; no `any` where the repo style avoids it; importers pure/side-effect-free
until `runImport` applies.

### Acceptance criteria

1. **JSON**: a mem0-style/`{memories:[...]}` file with aliases, a `.jsonl` file, and
   stdin each import with `--apply`; a file with 3 good + 1 corrupt record imports 3 and
   reports 1 unresolved; a second run adds 0; `import verify` is green; `import rollback`
   removes exactly the run.
2. **Markdown**: a fixture vault (nested dirs, frontmatter, headings, wiki links, a
   `CLAUDE.md` and a `MEMORY.md`) imports the expected record count in both modes;
   `CLAUDE.md`/`MEMORY.md` are skipped without `--include-all`; a non-git directory
   produces user-scope records with a warning; second run adds 0; source hashes unchanged.
3. **Claude**: a fixture `~/.claude` with two project dirs (one with a JSONL carrying
   `cwd`, one without) imports project records for the first, unresolved for the second;
   legacy `memory/` imports as user scope; `MEMORY.md` is not a record; second run adds 0.
4. **Auto**: with fixture env dirs, `auto` prints the plan and exits 0 without writes;
   `--apply` without `--yes` in a non-TTY fails with exit 2; `--apply --yes` imports each
   store under separate runIds; a second run reports 0 added for every source; rollback of
   one source leaves the others intact.
5. **Safety**: dry-run creates no memories/ledgers/backups; every applied run's manifest
   verifies `sources unchanged`; `HARNMEM_DEBUG` off means no stack traces on expected
   failures.

### Implementation status (2026-10-25)

P1–P6 landed as one change set; the criteria above are covered by
`packages/cli/test/*.test.mjs` (9 tests) and the monorepo suite (61 tests: core 52 + CLI 9).

| Phase | Status | Landed in |
|---|---|---|
| P1 | ✅ shipped | `importers/json.ts` (rewritten), `importers/types.ts` (inference helpers), `commands.ts` (stdin), `main.ts` (`--jsonl`, `--mode`, `--max-files`, `--include-all`) |
| P2 | ✅ shipped | `importers/md.ts`, `pipeline.ts`, `commands.ts`, `main.ts` |
| P3 | ✅ shipped | `importers/claude.ts`, `session-cwd.ts` (`readClaudeSessionCwds`), `frontmatter.ts` (`fmNestedString`), `project-resolve.ts` (`HarnessId`), `identity.ts` (`findGitRepoRoot` export), `pipeline.ts`, `commands.ts` |
| P4 | ✅ shipped | `commands.ts` (`cmdImportAuto`), `main.ts` |
| P5 | ✅ shipped | `prompts/migrate.md`, `prompts/README.md`, `docs/user-guide.md` §8, `packages/cli/README.md`, `docs/README.md` index, `docs/ROADMAP.md`, `CHANGELOG.md` |
| P6 | ✅ shipped | `packages/cli/test/{helpers,import-json,import-md,import-claude,import-auto,migration-prompt}.mjs`, CLI `test` script, root `test` script |

Evidence level: importer behavior is fixture-tested on Windows (node 26 locally, CI matrix
targets node 22); the Claude legacy `~/.claude/memory` layout remains **△ inferred** (no
real store on the dev machine), while the `projects/<slug>` layout was fixture-tested.

## 12. Risks and open questions

| Risk | Mitigation |
|---|---|
| Alias heuristics mis-type records | dry-run `by type` is the review gate; frontmatter/`type` always wins; source re-run after fixing |
| `heading` mode produces many tiny records | off by default; documented for note vaults where atomic notes are the unit |
| Git-root project detection on a vault containing many repos | nearest `.git` per file, cached per root; `--project` overrides; non-repo dirs go user scope with warnings |
| Claude legacy layout (`?`) | no real store on the dev machine; parser mirrors the documented layout and DSH's verified importer; fixture-tested; unresolved bucket catches surprises |
| Cross-source duplicates | accepted; `consolidate`/`supersedes` are the product answer; migration does not merge heuristically |
| Big stores | walker cap, per-record cap, batched agent recipe; `import md` reports counts before writing |
| Windows path/encoding | tests run on the ubuntu+windows CI matrix; UTF-8 BOM tolerated (existing readers strip it) |

Open question (deferred, not blocking v1): should `auto` also probe a curated list of
"vault" locations (`~/notes`, `~/Documents/notes`)? Current answer: no — auto scans only
harness memory stores; a random notes directory must be explicit (`--path`), because
tidiness beats magic for a write-adjacent command.
