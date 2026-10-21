# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `dsh-harnmem`: DSH adapter (cordis plugin) with byte-stable hot-index
  injection through `systemPrompt.section`, the same five `memory_*` tools,
  read-only subagents, end-of-session extraction bridged to the host LLM, and
  bounded shutdown. Verified against the real desktop runtime with a disposable
  profile and a local OpenAI-compatible mock endpoint (write in session 1,
  recall by injection in a new process).
- `@harnmem/core`: `renderHotContextSync()`, a synchronous cold-start renderer
  over the persisted shard indexes. It is byte-identical to
  `HarnMem.ensureContext()` and lets adapters inject memory on the very first
  prompt before asynchronous session bootstrap completes.
- Repository-wide English documentation and open-source project scaffolding
  (license, contribution guide, code of conduct, security policy, issue/PR
  templates, CI and release workflows).

### Changed

- `pi-harnmem`: new `toolPrefix` setting (default `memory_`) lets the adapter
  expose `harnmem_write`, `harnmem_search`, `harnmem_read`, `harnmem_forget` and
  `harnmem_status` instead, so it can run side by side with pi-memory, which
  registers the same `memory_*` tool names.
- `dsh-harnmem`: prompt section order is now 4050 (was 4000, which collides with
  dsh-auto-memory's section), making the composed prompt deterministic when both
  plugins are installed.

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
