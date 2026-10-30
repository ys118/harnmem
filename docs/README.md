# Documentation

The documentation is organized in five layers. If you are new, read the
[user guide](user-guide.md) first, then [`design/00-overview.md`](design/00-overview.md).

## User guide

- [User guide](user-guide.md) — install, first run, configuration, tools,
  `/memory` commands, migration, troubleshooting, privacy.
- [FAQ](faq.md) — short answers on storage/privacy, migration, adapters and
  common failures.
- [Roadmap and current status](ROADMAP.md) — what is done, what is running,
  known issues, and the ordered next steps (start here to continue development).

## Contributor guides

- [Adapter authoring guide](adapter-authoring.md) — add a CLI importer (bring a
  legacy store into HarnMem) or a runtime adapter (make a harness use HarnMem).
- [Contributing](../CONTRIBUTING.md) — quality bar, contribution gate, PR flow,
  local checks.

## Design (design of record)

| Doc | Contents |
| --- | -------- |
| [`design/00-overview.md`](design/00-overview.md) | Goals, non-goals, design principles, architecture at a glance |
| [`design/01-architecture.md`](design/01-architecture.md) | Components, data flow, technology choices, package layout, concurrency and security |
| [`design/02-data-model.md`](design/02-data-model.md) | Store layout, memory schema, scopes and project identity, format and migration mapping |
| [`design/03-retrieval.md`](design/03-retrieval.md) | Index structure, CJK+English tokenization, BM25F and scoring, injection budget and KV-cache strategy |
| [`design/04-write-and-lifecycle.md`](design/04-write-and-lifecycle.md) | Write path, extraction, dedupe/merge, supersede, decay/archival, audit |
| [`design/05-evaluation.md`](design/05-evaluation.md) | Evaluation suites (S1-S12), metrics, gates, ablations, optional LLM judge |
| [`design/06-implementation-plan.md`](design/06-implementation-plan.md) | Milestones, verified evidence, risks, release strategy |
| [`design/07-adapter-contract.md`](design/07-adapter-contract.md) | Adapter contract, tool semantics, KV-cache rules, execution-surface split |
| [`design/08-dsh-adapter.md`](design/08-dsh-adapter.md) | DeepSeek Harness adapter: plugin shape, hooks, injection, cold-start fallback, tools |
| [`design/09-claude-adapter.md`](design/09-claude-adapter.md) | Claude Code adapter: zero-dependency MCP stdio server + hooks, implemented as `packages/claude-harnmem` |
| [`design/10-migration-onboarding.md`](design/10-migration-onboarding.md) | Migration onboarding: relaxed JSON contract, `import md` / `import claude` / `import auto`, agent-assisted recipe, safety and acceptance criteria |

## Research notes

Background research that informed the design. These are notes, not normative
specifications; the design docs above are the source of truth.

| Doc | Contents |
| --- | -------- |
| [`research/reference-projects.md`](research/reference-projects.md) | mem0, Hindsight, OpenViking, opencode-mem, dsh-auto-memory, pi-memory, ZCode: adopt/adapt/reject |
| [`research/memory-evaluation-and-algorithms.md`](research/memory-evaluation-and-algorithms.md) | Memory benchmarks (LoCoMo, LongMemEval, ...), scoring/decay/dedupe algorithms, SQLite/FTS5 feasibility |
| [`research/pi-extension-api.md`](research/pi-extension-api.md) | The pi extension API, event payloads, context injection and KV-cache behavior |
| [`research/dsh-plugin-and-migration.md`](research/dsh-plugin-and-migration.md) | DSH plugin architecture and a per-harness migration mapping |
| [`research/dsh-impl-notes.md`](research/dsh-impl-notes.md) | DSH implementation notes: verified / inferred / unverified |
| [`research/prompt-review.md`](research/prompt-review.md) | Rationale and failure modes for the extraction/consolidation prompts |
| [`research/codex-plugin.md`](research/codex-plugin.md) | Codex plugin system (mcp servers + hooks + skills), real-machine probe evidence, codex-harnmem architecture |
| [`research/opencode-plugin.md`](research/opencode-plugin.md) | opencode v2 domain plugin API (`{id, setup(ctx)}`), real-machine probe evidence, opencode-harnmem architecture |

## Operations and evaluation

- [`../evals/README.md`](../evals/README.md) — deterministic evaluation harness,
  suites, gates, ablations, and how to add a suite.
- [`../packages/pi-harnmem/README.md`](../packages/pi-harnmem/README.md) — pi
  extension install and verification.
- [`../packages/dsh-harnmem/README.md`](../packages/dsh-harnmem/README.md) — DSH
  plugin install and verification.
- [`../packages/cli/README.md`](../packages/cli/README.md) — CLI command
  reference and migration guarantees.
- [`../packages/claude-harnmem/README.md`](../packages/claude-harnmem/README.md) —
  Claude Code plugin install and verification.
- [`../packages/codex-harnmem/README.md`](../packages/codex-harnmem/README.md) —
  Codex plugin install and verification.
- [`../packages/opencode-harnmem/README.md`](../packages/opencode-harnmem/README.md) —
  opencode plugin install and verification.

## Conventions

- Docs are written in English. CJK text may appear only as a data example where
  the point is language behavior (for example CJK tokenization).
- Design docs carry a status line at the top. If implementation and design
  disagree, open an issue rather than silently editing history.
- Numbers quoted in design docs are reproducible from the commands listed in
  [`design/05-evaluation.md`](design/05-evaluation.md) and `evals/README.md`.
