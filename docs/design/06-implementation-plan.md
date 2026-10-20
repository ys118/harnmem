# 06 · Implementation plan, verification evidence, and release strategy

> Status snapshot: evening of 2026-10-20 (Asia/Shanghai). This file records "how far we have come, how it is verified, what is next, and how to release".
> Design references: `00-overview.md` (goals/principles), `01-architecture.md` (components and data flows), `02-data-model.md` (SSOT layout), `03-retrieval.md` (retrieval), `04-write-and-lifecycle.md` (writes/governance), `05-evaluation.md` (evaluation gates), `07-adapter-contract.md` (adapter contract), `08-dsh-adapter.md` (DSH design), `09-claude-adapter.md` (Claude Code design).
> Research sources: `../research/pi-extension-api.md`, `../research/reference-projects.md`, `../research/memory-evaluation-and-algorithms.md`, `../research/dsh-plugin-and-migration.md`.

## 1. Milestones overview

| Milestone | Content | Status | Acceptance evidence |
|---|---|---|---|
| M0 Research | 4 research tracks: pi API / reference projects / evaluation algorithms / DSH plugin and migration | ✅ done | `docs/research/*.md` (~2,000 lines total) |
| M1 Core engine | Data model, storage, indexing, retrieval, writes, extraction, governance, facade | ✅ done; build + tests pass | `pnpm --filter @harnmem/core build`; `node --test packages/core/test/*.test.mjs` **19/19** |
| M2 pi adapter | 5 tools, /memory command, injection snapshots, auto-extraction, subagent read-only | ✅ done, verified end-to-end in a real pi session; hardening items pending (§6 item D) | `packages/pi-harnmem/`; real `pi` 1.3.0 session runs |
| M3 Evaluation | S1–S12 deterministic corpora, metrics, gates, A0–A5 ablations | ✅ done; all functional gates PASS (5 advisory items, see 05 §3.1) | `evals/README.md`, `evals/results/eval-report.md` |
| M4 Governance | Mechanical dedupe/merge, bitemporal supersede, decay/archive/trash, capacity, audit | ✅ core done; LLM digest is an optional phase | `packages/core/src/{lifecycle,consolidate}.ts`, `prompts/consolidate-digest.md` |
| M5 CLI + migration | `harnmem` commands, dsh/pi/zcode/json import, dry-run/ledger/rollback | ✅ done; verified end-to-end on copies of real directories (second import adds 0, rollback verified) | `packages/cli/` |
| M6 DSH plugin | cordis plugin, systemPrompt.section injection, tools, end-of-session extraction | 🟡 design done (08), implementation not started (no runtime e2e environment) | `docs/design/08-dsh-adapter.md` |
| M7 Claude Code | hooks + zero-dependency MCP stdio server | 🟡 design done (09, in the repo) | `docs/design/09-claude-adapter.md` |
| M8 Release | npm packages/install docs/versioning/CI | 🟡 v0.1.0 usable locally + docs complete; `pi install ./packages/pi-harnmem` and npm publish not done | §5/§7 of this file |

## 2. Repository map (current reality)

```
harnmem/
├── packages/
│   ├── core/          @harnmem/core: types/config/project/store/indexer/text/retrieval/
│   │                  lifecycle/extract/consolidate/harnmem/frontmatter/util + test/
│   ├── pi-harnmem/     pi extension: index/state/context/tools/command/format/journal/subagent/log
│   └── cli/           harnmem CLI: main/args/commands/pipeline/importers/{dsh,pi,zcode,json}
├── evals/             gen/ (deterministic generator), data/ (lexicons/bilingual/synonyms), lib/ (metrics/store), run.mjs, gates.json
├── prompts/           extract.md / write-policy.md / consolidate-digest.md / README.md (loading contract)
├── data/              synonyms.zh.txt (Chinese synonyms, 194 entries)
├── docs/
│   ├── research/      pi-extension-api / reference-projects / memory-evaluation-and-algorithms /
│   │                  dsh-plugin-and-migration / dsh-impl-notes / prompt-review
│   ├── design/        00–09 (this directory)
│   └── user-guide.md  end-user guide (install/config/tools/data layout/troubleshooting)
└── README.md          project overview
```

Conventions: `docs/` holds designs and evidence; `packages/` holds publishable artifacts; `evals/` and internal verification aids are not published; `prompts/` and `data/` ship with core (default assets, overridable via `~/.harnmem/prompts/`).

## 3. Verified facts (reproducible)

### 3.1 Core engine

```powershell
cd <repo>
pnpm install
pnpm --filter @harnmem/core build
pnpm test                      # 19/19 pass
```

Coverage: write/read/retrieval, dedupe decisions, bitemporal supersede, forget+restore, importRecords, consolidate (mechanical), in-memory index rebuild, hot-index buildContext byte stability (two calls produce identical text), cross-shard two-hop link diffusion, MMR candidate pool, lex calibration, prompt asset deployment/template filling, TAB synonym parsing, explicit supersedes. Tests use a temporary `HARNMEM_HOME` and never touch real user data.

### 3.2 pi adapter end-to-end in a real session

Verified with a real `pi` 1.3.0 process and temporary `PI_HOME`/`HARNMEM_HOME` directories:

- `pi -p -e packages/pi-harnmem/dist/index.js` loads the extension and registers 5 tools;
- session A writes a memory via the tool → session B (new process) sees that memory in the injected system-prompt block;
- in the same session, two consecutive `before_agent_start` injections produce identical sha256 (KV-cache stability), invalidating and rebuilding after a write;
- a subagent (background fork) neither re-writes nor re-extracts (the root session owns that).

### 3.3 Evaluation (2026-10-20 19:12 final)

`node evals/run.mjs --engine core --gate --report` (all 12 suites, 80.8s):

| suite | Key metrics | Result |
|---|---|---|
| S1/S2/S3/S4/S11 | R@10 = 1.000; S2 scope leak = 0; S3 old-value leak@3 = 0; S4 no recall after forget | ✅ |
| S5 | **both_recall@10 = 1.000** (0.200 before the fix) | ✅ |
| S6 | abstain_fp = 0.000 (0.075 before the fix) | ✅ |
| S7 | P@1 = 1.000, noise@10 = 0 | ✅ |
| S8 | cross-lingual R@10 = 1.000; P@1 = 0.225 (known ranking limitation) | ✅ (R@10 gate) |
| S9 | 10k: R@10 = 1.000; import ~12 s, p95 ~16 ms | ✅ recall; ADVISORY performance |
| S10 | action = 1.000, over_merge = 0.000, supersede old/new recall 1.000 | ✅ |
| S12 | injection 206 tokens p95, pinned 1.000 | ✅ |

Aggregate: **R@10 1.000, MRR 0.891, nDCG@10 0.911, P@1 0.833, zh-en gap 0**; all functional gates green, 5 structural/performance items advisory (S9 import/p95, index_overhead 47×, search p95, build_ms_10k). The final table is in `evals/results/eval-report.md`, with the machine-readable version in `evals/results/latest.json`.

### 3.4 CLI and migration

The command surface is documented in `packages/cli/README.md`. Migration was verified end-to-end on copies of real source directories (the real `~/.dsh/memory` and `~/.pi/agent/memory` were never modified). Core principles: dry-run by default, back up first, ledger-based idempotency, failures go into an unresolved bucket, and unknown projects are never silently placed in user scope. Measured: 28 records migrated from a DSH copy, second import added 0, rollback clean; 10 records auto-resolved from a pi copy with 22 landing in unresolved (expected behavior when project identity is irrecoverable; `--path-map` can resolve them).

## 4. Implementation-phase plan (next-step order)

1. ✅ **Core retrieval wrap-up**: adjacency lists, cross-shard two-hop diffusion, lex calibration, MMR pool cap; S9 R@10 1.000, warm p95 ~16 ms.
2. ✅ **Evaluation final**: intended-action corpus (S10), uncapped 10k suite (S9), ablations, final report.
3. ✅ **pi adapter hardening**: tool schemas, abort signal, shutdown extraction race, `/memory` argument passthrough; 19/19 tests.
4. ✅ **CLI/migration acceptance**: DSH/pi copy import, idempotent re-import, rollback.
5. ✅ **Documentation consistency**: 02/03/04/05/07/README aligned; 08/09 adapter designs recorded.
6. 🟡 **Release preparation**: build, tests and eval gate are green; the `pi install` path is verified. GitHub release and npm publishing are opt-in maintainer steps, not code work.
7. **Later**: DSH plugin implementation (08), Claude Code MCP+hooks (09), cross-harness concurrent-write stress tests, ZCode migration samples, v0.2 performance work (import/p95/index_overhead).

## 5. npm packaging and release strategy

**Principles: local first, reversible; publish core and adapters separately; never publish a package without e2e evidence.**

| Package | Content | Publish form | Dependencies |
|---|---|---|---|
| `@harnmem/core` | Engine + types + default prompts/data | ESM `dist/` + `.d.ts` | zero runtime dependencies |
| `harnmem` | CLI (bin: `harnmem`) | ESM + bin shim | exact version of `@harnmem/core` |
| `pi-harnmem` | pi extension | ESM; `package.json`'s `pi.extensions: ["dist/index.js"]`, `keywords:["pi-package"]` | peer: `@earendil-works/pi-coding-agent`, `pi-ai`, `typebox`; dep `@harnmem/core` |
| `harnmem-dsh` / `mcp` (`@harnmem/mcp`, Claude Code hooks + MCP) | later adapters | same core/protocol form | same as above |

- Phase 1: `pi install ./packages/pi-harnmem` (local path), no publishing; publish to npm only after the UX is confirmed.
- Publish with `pnpm -r publish --access public`; `workspace:*` is rewritten to concrete versions at publish time; first run `pnpm pack` to check the `files` allowlist (only `dist/`, `prompts/`, `data/`, README).
- `@harnmem/core` and the adapters' peer dependencies are not bundled, avoiding duplicate instances; pi declares the core package as a peerDependency, provided by the host on the pi side.
- Versioning: core and adapters use independent semver; `HARNMEM_API_VERSION` is exported from types.ts and validated by adapters on load.
- Data compatibility: `schema` field + `state/VERSION`; upgrades are additive only, and migration scripts go through `harnmem doctor --migrate`.
- MIT is the chosen license; repository hosting and the first npm publish are maintainer steps (see the pre-release checklist).

## 6. Risk register

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | Lexical saturation lets recency/importance outrank exact matches | 10k-suite recall collapse | Min-max × saturation calibration + regression corpora; the S9 gate guards it (currently R@10 1.000) |
| R2 | Query latency at 10k scale (MMR/link diffusion) | Per-turn injection over budget | Adjacency lists, candidate-pool caps, warm benchmarks; target p95 < 20ms |
| R3 | Auto-extraction latency/cost | Slower session shutdown | Root sessions only, master switch, 8–12s self-timeout, silent failure, cost fields in the audit |
| R4 | KV-cache stability | Cache invalidation every turn, higher cost | Snapshot + byte stability + `snapshotDirty`; rebuild only on writes/day rollover; e2e verified identical sha256 |
| R5 | Multi-harness concurrent writes (pi/DSH/CLI at once) | Index/record races | Atomic writes + `state/lock` + per-shard seq + usage overlay; single-writer preference; concurrency stress tests later |
| R6 | DSH plugin API is source-inferred, no runtime e2e | Implementation rework | 08 labels verified/inferred/unverified + a 10-step manual test plan; validate with a minimal plugin first |
| R7 | ZCode migration has no real data | Low coverage | Implement against the mechanism doc + graceful skips + clear warnings; wait for user-provided samples |
| R8 | pi `session_shutdown` has no timeout | Stuck on exit | Engine self-timeout (same ~8s policy as pi-memory) + AbortSignal |
| R9 | Sensitive information written into memories | Privacy leak | Regex redaction before write, `sensitive` flag excluded from injection by default, audit |
| R10 | Project identity (projectId) not reversible | Migration to the wrong scope | Recover cwd from session logs + `--path-map` + unresolved bucket; never silently land in user scope |

## 7. Pre-release checklist (v0.1.0, pi-first)

- [x] `pnpm -r build` and `pnpm test` fully green (19/19); `node evals/run.mjs --gate` hard gates fully green
- [x] pi adapter hardening fixes and e2e re-run
- [x] CLI migration e2e: copies of source directories → dry-run → apply → second import adds 0 → rollback
- [x] Cold-start path measured on a brand-new `~/.harnmem` home (no config, no prompt overrides)
- [x] README quick start verified item by item (`pi install ./packages/pi-harnmem` in an isolated profile, `harnmem stats`)
- [x] Data-safety review: `evals/` and `.tmp/` are not in the package; real memory directories are never modified (compare mtime)
- [x] Version numbers and CHANGELOG
- [ ] `npm pack` content listing + registry install validation (maintainer step, after the repository is public)
