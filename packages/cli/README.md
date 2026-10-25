# @harnmem/cli

The `harnmem` command: inspect the store, search/read/write memories, and migrate
legacy harness memory stores (DSH `dsh-auto-memory`, pi memory, ZCode) into the
shared `~/.harnmem` plain-file store.

Zero runtime dependencies beyond `@harnmem/core`; runs on Node >= 22.15 (`node:zlib`
zstd for DSH session logs).

## Install

```bash
npm install -g @harnmem/cli
```

## Usage

```text
harnmem stats
harnmem search "deployment rule" --limit 5
harnmem read mem_0123456789abcdefghijklmnop --history
harnmem write --type feedback --title "Never force-push main" \
  --content "**Why:** shared repo. **How to apply:** open a PR." \
  --tags git,workflow --importance 7
harnmem forget mem_...            # trash (30d grace), --hard to delete now
harnmem restore mem_...
harnmem consolidate --dry-run
harnmem export --out backup.json  # ImportRecord[]
```

## Synonyms

The shipped `data/synonyms.<lang>.txt` tables are generic; this command turns your
own memories into reviewed, corpus-validated candidates for a local table:

```text
harnmem synonyms list                                        # discovered tables + counts
harnmem synonyms suggest --dump-prompt [--out prompt.txt]    # no network: print the prompt
harnmem synonyms suggest --from-response answer.json         # validate a saved model answer
harnmem synonyms suggest --llm-url http://127.0.0.1:11434/v1 --llm-model qwen3:8b
harnmem synonyms suggest --write                             # append accepted groups
harnmem synonyms check [--file <path>] [--limit 3] [--k 10]  # rank before/after
```

- Reads `<home>/memories/**/*.md` plus recent session journals (`--no-sessions` to
  skip), fills `prompts/synonyms.md`, and validates every returned group: the
  canonical term must occur in the corpus, must not already be covered by a loaded
  table, and synonyms may not be substrings of it. Rejections and their reasons go
  to stderr; `--json` returns the full payload.
- `--write` appends to `<home>/data/synonyms.<lang>-suggested.txt` (never the
  repository). The loader treats it as one more language table; delete a line or the
  file to retire a suggestion. The table is memoized per engine instance, so a new
  session picks it up.
- This is the only CLI code path that opens a network connection, and only when
  `--llm-url` (or `HARNMEM_LLM_URL`) is set. Key: `--llm-api-key` or
  `HARNMEM_LLM_API_KEY`; timeout: `HARNMEM_LLM_TIMEOUT_MS` (default 120000).
- `check` measures the file honestly: it picks memories that use the canonical term
  but not the probed synonym, queries them by that synonym, and compares the
  target's rank before/after installing the file, then removes the temporary table
  (and restores the original file). A synonym-only query that only expansion can
  match may still abstain — that is the precision guard, not a bug.

Global flags: `--home <dir>` (default `$HARNMEM_HOME` or `~/.harnmem`), `--cwd <dir>`,
`--project <id|path>`, `--json`, `--no-color`.

Exit codes: `0` ok, `1` runtime or verification failure, `2` usage error.

## Migration

```text
harnmem import auto                # dry-run: probe DSH / pi / ZCode / Claude Code stores, print a plan
harnmem import auto --apply        # one run (and one ledger) per source; y/N prompt in a TTY
harnmem import auto --apply --yes  # non-interactive
harnmem import dsh                 # dry-run by default: ~/.dsh/memory (+ sessions for cwd recovery)
harnmem import dsh --apply         # backup -> import -> ledger -> source-integrity check
harnmem import pi  --apply         # ~/.pi/agent/memory (MEMORY.md blocks + daily/ notes)
harnmem import zcode --apply       # optional; absent store is skipped
harnmem import claude --apply      # ~/.claude/projects/<slug>/*.md + legacy ~/.claude/memory
harnmem import md --path ./notes --apply            # any Markdown tree (one record per file)
harnmem import md --path ./notes --mode heading     # one record per H1/H2 section
harnmem import json --path backup.json --apply      # arrays, envelopes, field aliases
harnmem import json --path backup.jsonl --apply     # JSONL/NDJSON (or --jsonl)
cat export.json | harnmem import json --path -      # stdin
harnmem import list                # recorded runs
harnmem import verify [runId]      # re-read all ids + ensure sources untouched
harnmem import rollback [runId]    # hard-forget exactly what one run imported
harnmem import unresolved          # buckets that could not be attributed
```

`import auto` only scans *memory stores*; it never imports `CLAUDE.md`/`AGENTS.md`/IDE rule files (the host still reads them, so a copy would be injected twice). For stores without a parser — cloud memory services, transcripts, PDF/OCR text — use the shipped `prompts/migrate.md` recipe with your agent: it produces an `ImportRecord[]` JSON file that `import json` accepts.

Long form is equivalent (`--from` plus flags), useful for scripting:

```text
harnmem import --from dsh|pi|zcode|claude|json|md|auto --path <dir|file> [--dry-run] [--apply]
              [--jsonl] [--mode file|heading] [--max-files N] [--include-all]
              [--path-map map.json | key=id|path] [--project <id|path>] [--verify]
harnmem import --verify [runId] | --rollback <runId>
harnmem index rebuild              # alias of harnmem rebuild
```

Guarantees and rules:

- **Dry-run is the default.** Only `--apply` (or `--yes`) writes.
- Before writing, `--apply` copies the source tree to
  `<home>/state/backups/<runId>/source/` and records sha256 + mtime for every
  file in `manifest.json`; `verify` re-checks them, so migration never edits the
  legacy stores. (`auto` runs are separate per source, so rollback is per source.)
- Idempotent via `<home>/state/migrations/<runId>.json`: entries are keyed
  `harness|relativeOriginPath|originalId` with a content hash, so a second run
  imports 0 and changed sources are re-imported with a warning.
- `import json` accepts arrays, `{records|memories|data|results|items}` envelopes,
  JSONL and stdin, plus common field aliases (`name`→`title`, `text`/`memory`/`body`
  →`content`, `created_at`/`date`→`created`, `score`→`importance`, …). A bad file
  is a usage error; a bad record goes to the unresolved bucket and the rest import.
- `import md` imports `.md`/`.mdc`/`.mdx`/`.markdown`/`.txt` trees, honours
  frontmatter, infers type from frontmatter/tags/path, attributes each file to the
  nearest git repository (otherwise `user` scope + warning), and skips
  `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`/`.cursor*`/`MEMORY.md` unless `--include-all`.
  A dry-run may register discovered projects in `<home>/projects.json`; nothing else is written.
- Source mtimes/hashes are never touched; `SCRATCHPAD.md` / `recovery/` are
  skipped, and project identity is recovered from DSH session-log cwd
  (`session.v4.jsonl.zstd`), pi session JSONL, or Claude Code session JSONL (first
  256 KiB per project directory), with `--path-map key=<project-id-or-existing-path>`
  and an `imports/unresolved/` bucket as explicit fallbacks.
- Environment: `DSH_HOME` (default `~/.dsh`), `PI_AGENT_DIR` (default
  `~/.pi/agent`), `ZCODE_HOME` (default `~/.zcode`), `CLAUDE_CONFIG_DIR` (default
  `~/.claude`).

## Development

```text
pnpm --filter @harnmem/cli run build      # tsc -> dist/
pnpm --filter @harnmem/cli run typecheck
node packages/cli/dist/main.js --help
```

End-to-end coverage for the importers: run each importer against a copy of a source directory with `--dry-run` first, then compare the resulting store with `harnmem status`.
