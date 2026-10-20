# @harnmem/cli

The `harnmem` command: inspect the store, search/read/write memories, and migrate
legacy harness memory stores (DSH `dsh-auto-memory`, pi memory, ZCode) into the
shared `~/.harnmem` plain-file store.

Zero runtime dependencies beyond `@harnmem/core`; runs on Node >= 22.15 (`node:zlib`
zstd for DSH session logs).

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

Global flags: `--home <dir>` (default `$HARNMEM_HOME` or `~/.harnmem`), `--cwd <dir>`,
`--project <id|path>`, `--json`, `--no-color`.

Exit codes: `0` ok, `1` runtime or verification failure, `2` usage error.

## Migration

```text
harnmem import dsh                 # dry-run by default: ~/.dsh/memory (+ sessions for cwd recovery)
harnmem import dsh --apply         # backup -> import -> ledger -> source-integrity check
harnmem import pi  --apply         # ~/.pi/agent/memory (MEMORY.md blocks + daily/ notes)
harnmem import zcode --apply       # optional; absent store is skipped
harnmem import json --path backup.json --apply   # ImportRecord[] round-trip
harnmem import list                # recorded runs
harnmem import verify [runId]      # re-read all ids + ensure sources untouched
harnmem import rollback [runId]    # hard-forget exactly what one run imported
harnmem import unresolved          # buckets that could not be attributed
```

Long form is equivalent (`--from` plus flags), useful for scripting:

```text
harnmem import --from dsh|pi|zcode|json --path <dir|file> [--dry-run] [--apply]
              [--path-map map.json | key=id|path] [--project <id|path>] [--verify]
harnmem import --verify [runId] | --rollback <runId>
harnmem index rebuild              # alias of harnmem rebuild
```

Guarantees and rules:

- **Dry-run is the default.** Only `--apply` (or `--yes`) writes.
- Before writing, `--apply` copies the source tree to
  `<home>/state/backups/<runId>/source/` and records sha256 + mtime for every
  file in `manifest.json`; `verify` re-checks them, so migration never edits the
  legacy stores.
- Idempotent via `<home>/state/migrations/<runId>.json`: entries are keyed
  `harness|relativeOriginPath|originalId` with a content hash, so a second run
  imports 0 and changed sources are re-imported with a warning.
- Source mtimes/hashes are never touched; `SCRATCHPAD.md` / `recovery/` are
  skipped, and project identity is recovered from DSH session-log cwd
  (`session.v4.jsonl.zstd`) or pi session JSONL, with `--path-map key=<project-id-or-existing-path>`
  and an `imports/unresolved/` bucket as explicit fallbacks.
- Environment: `DSH_HOME` (default `~/.dsh`), `PI_AGENT_DIR` (default
  `~/.pi/agent`), `ZCODE_HOME` (default `~/.zcode`).

## Development

```text
pnpm --filter @harnmem/cli run build      # tsc -> dist/
pnpm --filter @harnmem/cli run typecheck
node packages/cli/dist/main.js --help
```

End-to-end coverage for the importers: run each importer against a copy of a source directory with `--dry-run` first, then compare the resulting store with `harnmem status`.
