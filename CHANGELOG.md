# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-10-30

### Added

- `grok-harnmem` 0.1.0: Grok CLI adapter. Grok renders the system prompt before
  `SessionStart` runs and drops hook output, so the adapter injects the memory
  index through the MCP `initialize.instructions` handshake and ships six tools
  (the five canonical ones plus `memory_context` for the full index), a
  `/grok-harnmem:memory` command, a recall skill, and a detached `SessionEnd`
  extractor that returns well inside Grok's 1.5 s plugin budget. The repository
  root is a Grok marketplace; `grok plugin install grok-harnmem --trust` records
  the explicit `[plugins] enabled` entry that keeps this plugin's `harnmem` MCP
  server when Grok also auto-loads the Claude Code plugin. Verified on Grok CLI
  1.0.70 (first-turn injection, tools, session-end extraction, coexistence).
- `cursor-harnmem` 0.1.0: Cursor desktop adapter. A `beforeSubmitPrompt` hook
  injects the memory snapshot once per conversation through the undocumented flat
  `additional_context` channel, an `afterAgentResponse` hook confirms delivery
  and re-arms injection when a turn fails, a `sessionEnd` hook journals and
  extracts the transcript in a detached child, and the `.cursor-plugin/` package
  ships always-on rules plus the five-tool MCP server. `cursor-harnmem-install`
  copies the plugin into `~/.cursor/plugins/local`, merges the three hooks into
  `~/.cursor/hooks.json` without clobbering existing entries, and its `--doctor`
  mode reports the plugin, hooks, MCP server and any Claude Code plugin import.
  Verified on Cursor desktop 3.27.22 (first-prompt injection, plugin MCP tools,
  one deduplicated journal per conversation); the follow-up probe round covered
  the compaction, subagent, project and MDM hook surfaces.

## [0.6.2] - 2026-10-30

### Fixed

- Seven-package audit wave: two deep-review passes over core, the CLI and all
  five adapter packages confirmed 21 real issues — 17 fixed here, the
  structural/design remainder tracked as N18-N20 in `docs/ROADMAP.md`.
  - `@harnmem/core` 0.4.2: `asOf` time filters compared `validTo` in the
    wrong direction (historical queries dropped records that were valid at
    that moment); the same-process extraction gate short-circuited before the
    durable audit check, so a session that grew after extraction was never
    re-extracted; hostile `projectId`/memory ids could traverse paths outside
    the home (ids, slugs and record file names are sanitized now, dots-only
    names hardened); a truncated/corrupt `.md` no longer revives as an
    untitled active record (it is skipped and reported); `maxBodyBytes`
    truncates on a UTF-8 byte boundary instead of UTF-16 code units (no more
    split surrogate pairs or 3x CJK overshoot); multi-line titles survive the
    YAML round trip; `HARNMEM_ASSETS_DIR` takes effect on every resolve
    instead of only the first; dead code removed. +7 regression tests (59
    total).
  - `@harnmem/cli` 0.4.1: project identity for scp-style remotes
    (`git@github.com:owner/repo.git`) now matches core — `import --apply`
    previously wrote memories into a directory no adapter reads; honours pi's
    real `PI_CODING_AGENT_DIR` env var.
  - `pi-harnmem` 0.4.4: the transcript journal is flushed under the previous
    session id and cleared on session switches (`/new`, resume, fork), so two
    sessions can no longer be extracted as one transcript attributed to the
    last one; config files coerce boolean-ish strings and token-budget
    numbers (`"enabled": "false"` used to be silently ignored); ships a
    `test` script and is wired into the root test chain.
  - `claude-harnmem` 0.4.3 / `codex-harnmem` 0.2.3: config files coerce
    boolean-ish strings the way opencode already did; plugin manifest
    versions match the package versions; the claude MCP server reports its
    real version (read from `package.json`); all vendored copies re-ship the
    fixed core.
  - `opencode-harnmem` 0.1.1: re-vendored with the fixed core.

## [0.6.1] - 2026-10-30

### Fixed

- `claude-harnmem` 0.4.2 / `codex-harnmem` 0.2.2: **ship the core asset
  defaults in the vendored copy**. The vendoring script copied only core's
  dist — so an npm/marketplace-installed plugin could not find
  `prompts/extract.md` or the `data/synonyms.{en,zh}.txt` tables
  (`findAssetRoot` starts at the module directory), silently degrading to the
  inline fallbacks: a shorter extraction prompt and 6 builtin synonym groups,
  i.e. measurably worse zh/en search recall. Both vendoring scripts now copy
  `prompts/` and `data/` into `vendor/core` (mirroring `opencode-harnmem`
  0.1.0, which shipped correct) and a dedicated test pins the vendored tree.
  Also in `claude-harnmem`: `formatSearch` no longer throws when
  `debug.shards` arrives as a non-array (the same guard codex and opencode
  already had). No store-format or protocol changes.

## [0.6.0] - 2026-10-29

### Added

- `opencode-harnmem` 0.1.0: opencode v2 adapter — the fifth harness. A single-file
  plugin (`export default { id: "opencode-harnmem", setup(ctx) }`) uses the
  v2 domain API probed against the real v2.1.4 binary: `session.hook("context")`
  injects the byte-stable memory snapshot once per session (empty store injects
  zero bytes; per-session caching keeps every LLM request byte-identical),
  `tool.transform` registers the five canonical memory tools as native tools
  (flat JSON-Schema args, async execute, no zod), and a `session.hook("prompt")`
  journals the previous turn's transcript into the core session journal after
  every user turn, so no-LLM extraction still lands and a later session can
  catch up. Engines open per `(mode, cwd, session)` with LRU eviction and
  concurrent-open dedup; subagent (`parentID`) sessions map to read-only
  engines and never poison the parent's write path. `HARNMEM_HOME` /
  `HARNMEM_DISABLED` / `HARNMEM_READONLY` / `HARNMEM_INJECT` /
  `HARNMEM_AUTO_EXTRACT` / `HARNMEM_DEBUG` and the usual config files all
  apply; `~` in home paths expands before resolution. Requires opencode >= 2.x
  (a version gate refuses to load on 1.x). `@harnmem/core` is vendored with its
  prompts and synonym data so the installed plugin directory is self-contained.
  Verified end-to-end on opencode v2.1.4 (`run --standalone`,
  `opencode-go/glm-5.3-flash`): plugin load, empty-store zero-byte injection,
  real-store injection quoting live pinned memories, write → cross-run search
  round trip, read/status (parallel tool calls included), multi-turn journal
  persistence, and friendly fallback text on invalid tool calls. Research and
  probe history: `docs/research/opencode-plugin.md`.
- `codex-harnmem` 0.2.0: **rollout backfill on session start** — Codex still
  has no SessionEnd hook, so a crashed or force-killed session previously lost
  its extraction entirely. The `memory_context` hook target now also scans the
  last three local date directories under
  `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (excluding the live
  thread), and queues a detached extraction payload for each rollout newer
  than a persisted high-water marker (newest extracted rollout file name, so
  re-runs are idempotent; a concurrent-worker race can at worst duplicate one
  journal, which core's write dedup absorbs). Never blocks injection and never
  throws. 205-line dedicated test. Already published to npm alongside this
  release.
- `codex-harnmem` 0.2.1: report the real package version as the MCP server
  `serverInfo` (was a hardcoded placeholder). Already published to npm
  alongside this release.

### Fixed

- CI now runs the `codex-harnmem` and `opencode-harnmem` test suites via the
  root `pnpm test` (previously only core, cli and claude ran on CI), and the
  codex rollout fixture no longer depends on the wall clock (dirs, filenames
  and the scan window all derive from one fixed instant; it started failing
  when the calendar moved past its hardcoded dates).
- `dsh-harnmem` repo hygiene: strip a UTF-8 BOM from `package.json` that could
  confuse strict JSON parsers downstream.

## [0.5.1] - 2026-10-28

### Fixed

- `claude-harnmem`, `pi-harnmem`, `dsh-harnmem`: expand a leading `~` in
  `HARNMEM_HOME` and config-file `home` values before resolution (the same
  `expandHome` semantics core and the CLI already use). A literal `~/.harnmem`
  previously created a wrong store directory — and in the DSH adapter, where
  the value was never resolved at all, even a relative path could. Patch
  release: all three adapters bump to 0.4.1 with dedicated regression tests;
  no protocol or store-format changes.

## [0.5.0] - 2026-10-28

### Added

- `codex-harnmem`: Codex CLI adapter — a `SessionStart` `mcp_tool` hook injects
  the byte-stable memory snapshot (empty store injects zero bytes; deterministic
  line-based truncation under the same 10,000-byte cap), and one bundled
  zero-dependency stdio MCP server carries seven tools: the five canonical
  memory tools plus two internal hook targets, `memory_context` (injection) and
  `memory_session_end` (capture). Session-end capture persists a payload file
  and a detached worker parses the Codex rollout JSONL
  (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`), dropping harness
  boilerplate envelopes and applying the same budgets as the Claude adapter
  (4,000-char clip, last 400 messages). Only the hook templates carry the real
  Codex thread id, so the server anchors on the first `session_id` and every
  later session-less model write lands with thread-scoped provenance
  (`source: {harness: codex, session: <threadId>}`). The repo root doubles as a
  Codex marketplace (`.agents/plugins/marketplace.json` →
  `packages/codex-harnmem`); `@harnmem/core` is vendored so the installed
  plugin directory is self-contained. Verified end-to-end against
  codex-cli 0.164.0-alpha.11.1 on Windows (`exec` injection, model write-back,
  clean uninstall restoring `config.toml` byte-identical). Upstream codex
  currently skips `SessionEnd` MCP hooks ("not supported"); the hook is
  declared anyway as forward-compat, and extraction also runs whenever the
  upstream ships support.
- `docs/research/codex-plugin.md`: first-hand research on the Codex plugin
  system (plugin manifests, MCP registration with `env_vars` allowlists, the
  hooks framework and hook trust, the rollout session data plane) with the
  real-machine probe evidence behind the adapter design.
- `docs/ROADMAP.md`: Phase G — N15 (this adapter) done; N16 backlog: desktop
  trust flow, GitHub sparse marketplace install, per-event hooks, npm release.

## [0.4.0] - 2026-10-27

### Added

- `claude-harnmem`: native Claude Code plugin — a `SessionStart` hook injects the
  byte-stable memory snapshot (empty store injects zero bytes; deterministic
  line-based truncation under Claude's 10,000-character `additionalContext`
  cap), a bundled zero-dependency stdio MCP server exposes
  `memory_search`/`memory_read`/`memory_write`/`memory_forget`/`memory_status`
  (tool outputs clipped at 12k chars, far under the 25k-token client cap), and a
  `/harnmem:memory` slash command gives the operator manual search/read/write/
  forget/status. Session-end extraction journals the transcript tail and
  re-processes it in a detached child (plugin hook timeout declarations are not
  honored upstream and background children must not inherit the hook's stdout —
  claude-remember #561/#646). Subagent sessions stay read-only and never
  extract; on Claude Code 2.1.310 Task subagents fire no session hooks at all,
  so the guards are a forward-compatible safety net. The repo root doubles as a
  Claude Code marketplace (`.claude-plugin/marketplace.json` →
  `packages/claude-harnmem`); `@harnmem/core` is vendored so the installed
  plugin directory is self-contained. Verified end-to-end against Claude Code
  2.1.310 (injection, MCP round-trip, command, real-store attach).
- `docs/research/claude-code-plugin.md`: first-hand research on the Claude Code
  plugin system (plugin/marketplace structure, hooks + `additionalContext`,
  in-plugin MCP, Windows pitfalls like UTF-8 BOM rejection and the 15-minute
  MCP failure cache) with the `claude-remember` post-mortem and the e2e
  evidence behind the adapter design.

## [0.3.0] - 2026-10-26

### Added

- `@harnmem/core`: synonym-suggestion engine API (`harvestTerms`,
  `buildSuggestPrompt`, `parseSuggestionGroups`, `validateSuggestions`,
  `suggestFromResponse`, `suggestSynonyms`) — turns local memories and session
  journals into corpus-validated synonym groups through a caller-supplied
  `LlmFn`. Every proposal must occur in the corpus, must not already be covered
  by a loaded table, and may not be a substring of its canonical; the engine
  still performs no network I/O.
- `@harnmem/cli`: `harnmem synonyms list | suggest | check` — inspect the tables
  actually loaded, propose validated groups (fully offline with `--dump-prompt`
  or `--from-response`, or through an opt-in OpenAI-compatible bridge
  `--llm-url`/`--llm-model`), append accepted groups to
  `<home>/data/synonyms.<lang>-suggested.txt` with `--write`, and measure the
  rank gain with `check` (the temporary table is installed for one comparison
  run and then removed).
- `prompts/synonyms.md`: editable prompt asset for the suggestion pass
  (`{{language}}`, `{{terms}}`, `{{existing}}`, `{{samples}}`), deployed to
  `<home>/prompts/` like the other assets; listed in `prompts/README.md` with
  its budgets.
- `pi-harnmem`: `statusLine` setting (default `true`, env
  `HARNMEM_STATUS_LINE=1|0`) — set `false` to stop drawing the footer line
  `harnmem: N entries · ~T tokens · <sha>`. Injection, tools and extraction are
  unchanged; `/memory status` still reports the snapshot.
- `@harnmem/cli`: migration onboarding — `harnmem import auto` probes the known
  memory stores (DSH, pi, ZCode, Claude Code), prints a plan and imports each
  source as its own run/ledger (`--apply`, TTY y/N, `--yes` for non-interactive);
  `harnmem import claude` imports `~/.claude/projects/<slug>` memory files with
  project attribution recovered from the session JSONL `cwd`; `harnmem import md
  --path <dir|file>` imports any Markdown/`.txt` tree in `file` or `heading` mode,
  honoring frontmatter and inferring type/scope/project; `harnmem import json` now
  accepts arrays, `{records|memories|data|results|items}` envelopes, JSONL/NDJSON
  (`--jsonl`), stdin (`--path -`), common field aliases and infers missing
  type/title, while bad records go to the unresolved bucket instead of aborting
  the file. See `docs/design/10-migration-onboarding.md`.
- `prompts/migrate.md`: agent-facing migration recipe (deployed to
  `<home>/prompts/`, never engine-loaded) for legacy stores without a
  deterministic importer — the agent reads the old memory, writes an
  `ImportRecord[]` JSON file and runs `harnmem import json --apply --verify`.
- Documentation for migration onboarding: `docs/faq.md` (general, migration,
  adapters and troubleshooting answers), `docs/adapter-authoring.md` (Track A CLI
  importer contract and Track B runtime adapter contract), a five-layer
  documentation index, and a refreshed README/harness-support table. The roadmap
  items for the migration guide and adapter-authoring guide are complete.

### Changed

- `@harnmem/core`: synonym tables are now discovered per language — every
  `data/synonyms.txt` or `data/synonyms.<lang>.txt` under `<home>/data` and the
  repository `data/` is loaded and merged (the `<home>` copy wins per filename),
  so adding a language is a data-only change. The English rows moved out of the
  Chinese table into `data/synonyms.en.txt` (164 entries in effect: 129 zh + 35
  en), and the shipped tables were reduced to deliberately generic vocabulary.

### Fixed

- `@harnmem/cli`: `harnmem --version` and the startup banner report the version
  from the installed package manifest instead of the stale hard-coded `0.1.0`.
- `@harnmem/core`: the npm tarball now ships `prompts/` and `data/`, so an npm
  install deploys the same editable assets to `<home>/prompts` and `<home>/data`
  (including `prompts/migrate.md`) as a repository checkout. Previously the
  first run created those directories empty.

## [0.2.0] - 2026-10-24

### Added

- `dsh-harnmem`: DSH adapter (cordis plugin) with byte-stable hot-index
  injection through `systemPrompt.section`, the same five tools (default
  `harnmem_*` prefix), read-only subagents, end-of-session extraction bridged to
  the host LLM, and bounded shutdown. Verified against the real desktop runtime
  with a disposable profile and a local OpenAI-compatible mock endpoint (write
  in session 1, recall by injection in a new process).
- `dsh-harnmem`: file logger writing `~/.harnmem/logs/dsh.jsonl` (JSON lines,
  bounded chained sink, flushed on unload) and a `log: "off" | "errors" | "on"`
  setting; `on` is the trial default.
- `@harnmem/core`: `kind:"extract"` audit events for every session-end outcome
  (`status`, `reason`, `added`/`superseded`/`skipped`,
  `messages`/`userMessages`), closing the observability gap in N13.
- `@harnmem/core`: `renderHotContextSync()`, a synchronous cold-start renderer
  over the persisted shard indexes. It is byte-identical to
  `HarnMem.ensureContext()` and lets adapters inject memory on the very first
  prompt before asynchronous session bootstrap completes.
- Repository-wide English documentation and open-source project scaffolding
  (license, contribution guide, code of conduct, security policy, issue/PR
  templates, CI and release workflows).
- `docs/ROADMAP.md`: live status (trial evidence, known issues) and the ordered
  next steps with acceptance criteria and a verification runbook.

### Changed
- `dsh-harnmem`: resume catch-up extraction — on attach the digest is hydrated
  from the durable session journal and a `sessionEnd(reason:"resume_catchup")`
  runs while the host LLM is alive, so a quit-path extraction that the host tears
  down at unload lands on the next open of the same session. Verified in the real
  headless runtime (journal 6/3 → `extract added:1`).
- `@harnmem/core`: cross-process extraction idempotency via the `extract` audit
  watermark (`messages` count), an explicit `digest_too_small` skip, and LLM
  failures surfaced as `status:"failed"`; `store.readSessionTranscript()` journal
  reader (deduped, chronological, BOM-tolerant).

- `pi-harnmem`: new `toolPrefix` setting (default `memory_`) lets the adapter
  expose `harnmem_write`, `harnmem_search`, `harnmem_read`, `harnmem_forget` and
  `harnmem_status` instead, so it can run side by side with pi-memory, which
  registers the same `memory_*` tool names.
- Trial: `dsh-auto-memory` (desktop profile) and `pi-memory` were disabled
  after the N4 migration, making `~/.harnmem` the single memory store (N3 option
  b). The legacy stores stay on disk as read-only archives and the pre-change
  profile/pi configs are backed up, so rollback is a file restore.
- `dsh-harnmem`: prompt section order is now 4050 (was 4000, which collides with
  dsh-auto-memory's section), making the composed prompt deterministic when both
  plugins are installed.
- `dsh-harnmem`: default `toolPrefix` is `harnmem_` (the adapter previously
  registered bare `memory_*` names that `dsh-auto-memory` already owned),
  `llmTimeoutMs` default is 60 s (measured desktop catch-up 33–37 s), the digest
  evicts the oldest non-user entry first so early prompts survive tool noise,
  and the extraction LLM call uses a local chunk-protocol bridge instead of a
  `@deepseek-ai/dsh-llm` import that cannot resolve from a linked install.

### Fixed

- `dsh-harnmem`: write-side silence (docs/research/dsh-write-silence-2026-10-23.md).
  Five independent blockers made every write path fail with no diagnostic:
  shadowed tool names, a 200-event digest that evicted early user prompts, a
  fire-and-forget dispose handler, an 8 s budget racing a ~11 s extraction, and
  a swallowed host-module import that turned LLM failures into
  `status:"done", added:0`. Repro'd end-to-end on the installed DSH 0.2.1-rc.2:
  three user turns now produce `extract added:3` in `audit.jsonl`, three memory
  files, and injection of those memories (719 B / 170 tokens) in the next
  session.
- `dsh-harnmem`: quit-time extraction. The host disposes the provider adapters
  before `plugin_unload`, so the dispose-time extraction could never call a model
  (`code:"NO_ADAPTER"`). The adapter now hydrates the digest from the durable
  journal at attach and runs the extraction as a `resume_catchup` while the LLM is
  alive; a completed extraction is not repeated (audit watermark). Headless real
  runtime: `extract.catchup added:1`, one memory file written.
- `@harnmem/core`: short-digest and LLM failures were reported as
  `status:"done", added:0`; they are now `digest_too_small` / `failed`. Journal
  readers tolerate a leading UTF-8 BOM so hydration cannot silently lose the first
  prompt.
- `@harnmem/cli`: `import` pre-assigns memory ids and remaps legacy
  `[[wiki links]]` from source slugs to those ids, so migrated records no longer
  land as orphan links (the N4 rehearsal surfaced 22 orphans on a scratch home;
  the real dsh run resolved 21 links and dropped 0 targets outside the batch).
  The ROADMAP records the N4/N5 evidence (backups, `import verify`, idempotent
  second runs, scratch-home rollback, merged-store scope checks).

## [0.1.0] - 2026-10-20

First public, pi-first release. The memory data model, retrieval engine and
evaluation harness are usable; the DSH and Claude Code adapters are designed but
not implemented.

### Added

- `@harnmem/core`: harness-agnostic memory engine with a plain-file store
  (`~/.harnmem/`), Markdown-with-frontmatter memory entries, project identity
  derived from git remotes or paths, file-native user/project scopes, and a
  versioned on-disk schema.
- Deterministic retrieval: CJK-aware tokenizer (character bigrams for Chinese),
  BM25F field weighting, lexical + importance/confidence/recency/usage/pin/link
  scoring, two-hop link diffusion across shards, MMR diversification and an
  injection token budget. No embedding model, no vector database, no service.
- Write path: ADD-only semantics with a bi-temporal `superseded` chain
  (`valid_from` / `valid_to`), mechanical deduplication (SimHash + character
  n-gram Jaccard), merge with provenance, soft delete via `trash/`, restore,
  and an append-only `state/audit.jsonl`.
- Lifecycle governance: value scoring, Ebbinghaus-style retention decay,
  active -> archived -> trashed transitions, per-scope capacity limits.
- Extraction: end-of-session LLM extraction with a JSON schema, bounded
  timeout, dedupe against existing memories, confidence threshold, idempotent
  cursor, and prompt assets that can be overridden per home directory.
- `pi-harnmem` (pi 1.3.0): byte-stable hot-index injection, five memory tools,
  `/memory` command, read-only subagents, session-end extraction, and journal
  logging. Verified end-to-end against a real pi installation.
- `@harnmem/cli`: `harnmem stats/search/read/write/forget/restore/consolidate/
  rebuild/export/import/doctor`, with idempotent migration importers for DSH
  (`dsh-auto-memory`), pi memory, ZCode and JSON, including dry-run, backups,
  ledger, source-integrity verification and rollback.
- Evaluation harness: 12 deterministic suites (S1-S12) covering profile,
  project scoping, temporal supersede, forgetting, multi-hop links, abstention,
  distractors, bilingual retrieval, 10k-document long tail, consolidation,
  noisy text and token budgets; micro/macro metrics, hard/advisory gates and
  ablations.
- Design documentation: data model, retrieval, write lifecycle, evaluation,
  adapter contract, plus DSH and Claude Code adapter designs.

### Known limitations

- DSH and Claude Code adapters are design-only in this release.
- 10k-document stores import in roughly 12 s and serve warm queries at
  p95 ~16 ms; index size is ~2.9x the canonical store (47x the body text).
  These are tracked as advisory performance items, not correctness gates.
- The pi extension requires pi >= 1.3.0 and has been exercised on Windows with
  Node.js 24.
- Packages are not published to npm yet; build and install from a local
  checkout.
