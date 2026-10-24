# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- `dsh-harnmem`: prompt section order is now 4050 (was 4000, which collides with
  dsh-auto-memory's section), making the composed prompt deterministic when both
  plugins are installed.
- `dsh-harnmem`: default `toolPrefix` is `harnmem_` (the adapter previously
  registered bare `memory_*` names that `dsh-auto-memory` already owned),
  `llmTimeoutMs` default is 20 s (measured extraction 10.8–14.1 s), the digest
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
