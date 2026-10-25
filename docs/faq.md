# FAQ

Short answers to the questions that come up most often. Each answer links to the
document that is normative for that topic; when in doubt, the user guide and the
`--help` output win.

- [General](#general)
- [Migration](#migration)
- [Adapters and harnesses](#adapters-and-harnesses)
- [Troubleshooting](#troubleshooting)

## General

### What is HarnMem?

Cross-harness, file-native agent memory: one local Markdown/JSON store under
`~/.harnmem/` shared by pi, DeepSeek Harness (DSH) and the CLI. Retrieval is a
deterministic local index; there is no service, vector database or embedding
model. Start with the [user guide](user-guide.md), then
[`design/00-overview.md`](design/00-overview.md).

### Which harnesses are supported today?

| Harness | Status |
|---|---|
| pi 1.3.0 | Supported (`pi-harnmem` extension) |
| DeepSeek Harness 0.2.x | Supported (`dsh-harnmem` plugin) |
| CLI (any harness) | Supported (`harnmem` commands over the same store) |
| Claude Code | Adapter is design-only ([`design/09-claude-adapter.md`](design/09-claude-adapter.md)); its memory files can already be migrated with `harnmem import claude` |
| Other harnesses | The contract is in [`design/07-adapter-contract.md`](design/07-adapter-contract.md); the recipe is in [adapter-authoring.md](adapter-authoring.md) |

### Does anything leave my machine?

The engine and the CLI never open the network. An adapter may call the model
provider the harness already configured (session-end extraction, and only when
extraction is enabled); `harnmem synonyms suggest --llm-url <url>` is the one CLI
command that talks to an endpoint, and it is opt-in. See
[`design/01-architecture.md`](design/01-architecture.md).

### Where is the data, and can I edit it by hand?

Yes: plain Markdown with YAML frontmatter plus JSON state files under
`~/.harnmem/` (override with `HARNMEM_HOME` or `--home`). Indexes are derived and
rebuildable (`harnmem rebuild`). Layout and schema:
[`design/02-data-model.md`](design/02-data-model.md).

### Is it encrypted? Can I store secrets in it?

No encryption: the store is plain text by design (diffable, backup-friendly), so
protect it like any other local data. Do not store passwords, tokens or
credentials; `sensitive: true` marks a record for extraction/review but is not a
security boundary. See [SECURITY.md](../SECURITY.md).

### Why do I only see short index lines in the context, not full memories?

Injection is budgeted: the harness gets type/title/description lines so the
prompt stays small and byte-stable (KV-cache friendly); the model reads full
bodies through the memory tools when it needs them. Keyed by the same reason:
injected text changes only on session start, compaction, memory writes and day
rollover. Details: [`design/03-retrieval.md`](design/03-retrieval.md).

### How large can the store get?

The evaluation corpus (12 suites, 565 queries, 27,510 documents) is the current
evidence; advisory performance is ~12 s for a 10k import, ~16 ms warm search p95,
index ~2.9× the canonical store. Very large stores are tracked in
[ROADMAP.md](ROADMAP.md). Numbers are reproducible per
[`design/05-evaluation.md`](design/05-evaluation.md).

### Does it de-duplicate memories?

Writes are ADD-only with explicit `supersedes`; near-duplicates are merged by the
consolidation pass, and a wrong merge can be undone by reading the old wording
with `as_of`. Nothing is silently overwritten:
[`design/04-write-and-lifecycle.md`](design/04-write-and-lifecycle.md).

## Migration

### I don't know which importer to use. Where do I start?

```bash
harnmem import auto          # probes DSH / pi / ZCode / Claude Code stores, prints a plan
harnmem import auto --apply  # one run per source; y/N prompt in a terminal
```

`auto` never imports repository instruction files (`CLAUDE.md`, `AGENTS.md`, IDE
rule files): their host still reads them, and a copy would be injected twice. For
a custom directory use `harnmem import md --path <dir|file>`. Overview:
[user guide §8](user-guide.md#8-migration), design:
[`design/10-migration-onboarding.md`](design/10-migration-onboarding.md).

### Does migration touch or delete my old store?

No. Discovery is read-only; dry-run is the default; `--apply` first copies the
source to `<home>/state/backups/<runId>/source/` with a sha256+mtime manifest,
imports, writes a ledger and then verifies that every source file is unchanged.
`harnmem import verify <runId>` re-checks it later.

### How do I undo a migration?

```bash
harnmem import list              # find the runId
harnmem import rollback <runId>  # hard-forget exactly what that run imported
```

Each run (including each `auto` source) has its own ledger, so rollback is
per-source. The backup stays on disk for inspection.

### A second run imported 0 records. Is that a bug?

No, that is idempotency: entries are keyed `harness|relativeOriginPath|originalId`
with a content hash in the run ledger, so an unchanged source is skipped. If a
source file changed, the record is re-imported with a warning.

### What does "unresolved" mean, and how do I fix it?

The record is valid but cannot be attributed to a project (or is a corrupt JSON
record). Inspect the buckets and re-run with attribution:

```bash
harnmem import unresolved
harnmem import pi --apply --project <id|path>        # or --path-map key=id|path
```

The pi daily notes are the common case: session logs carry no session→cwd
mapping, so 22 daily entries were unresolved in the recorded run.

### Claude Code: import the memory or use the adapter?

`harnmem import claude` migrates the memory files (`~/.claude/projects/<slug>/`
and legacy `~/.claude/memory/`). The Claude Code *adapter* that makes Claude read
from HarnMem at runtime is a separate, still-unbuilt design
([`design/09-claude-adapter.md`](design/09-claude-adapter.md)).

### Can I migrate from Cursor, Windsurf, mem0, Letta or a cloud memory service?

Not with a dedicated parser: those formats drift and the maintenance cost is not
worth it. Export to JSON/JSONL and use the relaxed contract
(`harnmem import json --path <file>`; arrays, envelopes, aliases, stdin), or use
the shipped agent recipe for anything unstructured:

```bash
# deploy happens on first engine open; the file lands in <home>/prompts/migrate.md
harnmem import json --path /tmp/migrated.json --apply --verify
```

See [prompts/migrate.md](../prompts/migrate.md). SQLite-backed tools: export JSON
first; a `node:sqlite` reader is a possible later addition, not part of v1.

### How do I move memories to another machine, or merge two stores?

Copy `~/.harnmem/` (plain files; it is the simplest and preserves ids/links), or
use the portable round-trip:

```bash
harnmem export --out memories.json
harnmem import json --path memories.json --apply   # on the other machine
```

Importing two stores does not merge same concepts: use `harnmem consolidate` and
explicit `supersedes`. Do not point two active harnesses at one home over a sync
drive yet: concurrent writes are not fully validated (v0.2).

### Should I disable the old plugin first?

Import first, verify, then disable the old system — never delete the old store
immediately. Running both for a while is safe (duplicates are the only cost), and
it keeps rollback meaningful.

### What happens to links between memories?

Legacy wiki links are remapped to the new ids within a run; unmatched links are
reported (`legacy wiki links: N resolved, M dropped`) and dropped rather than
left dangling.

## Adapters and harnesses

### How do I make my harness use HarnMem?

Read [`design/07-adapter-contract.md`](design/07-adapter-contract.md) and follow
[adapter-authoring.md](adapter-authoring.md). The short version: construct the
engine for one session, inject `ensureContext()` byte-stably, map the five tool
semantics, call `sessionEnd()` at session end. `pi-harnmem` and `dsh-harnmem` are
the reference implementations.

### Why must the injected block stay byte-stable?

Prompt caching: the harness caches a prefix, and re-rendering the memory block
every turn invalidates it. Inject once per session (and on compaction, memory
writes, day rollover), keep ordering deterministic, and keep adapter-side output
identical for identical state. [`design/03-retrieval.md`](design/03-retrieval.md).

### How do I import another harness's memories?

That is the CLI importer track in
[adapter-authoring.md](adapter-authoring.md#track-a-import-a-legacy-store-into-harnmem):
implement one `discoverX()` function; backup, ledger, idempotency, verify and
rollback are already provided by the shared pipeline.

## Troubleshooting

The full table lives in [user guide §9](user-guide.md#9-troubleshooting). The most
common ones:

| Symptom | Fix |
|---|---|
| `harnmem: command not found` | `npm install -g @harnmem/cli`, or run `node packages/cli/dist/main.js` from a checkout |
| `Enospc` / permission errors | `HARNMEM_HOME` must be writable; the CLI exits 2 on usage errors, 1 on runtime failures |
| Unexpected stack trace | Run without `HARNMEM_DEBUG`; it is off by default and prints stacks only when set |
| Import reported unresolved | `harnmem import unresolved`, then re-run with `--project <id|path>` or `--path-map` |
| Old harness still injects memories | Disable its memory plugin after the HarnMem import verifies; otherwise both systems inject |
| Need to see why search returned nothing | `harnmem search "<query>" --json` and read `abstainReason` in the result |
