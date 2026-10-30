# Contributing to HarnMem

This guide exists to save both sides time.

HarnMem is cross-harness, file-native agent memory: one local Markdown/JSON
store under `~/.harnmem/`, shared by pi, DeepSeek Harness (DSH), Claude Code,
Codex and opencode. No services, no vector database, no embedding model:
retrieval is a deterministic local index over plain files.

Start with [README](README.md) for the overview,
[docs/user-guide.md](docs/user-guide.md) for installation and use,
[SECURITY.md](SECURITY.md) for private vulnerability reporting,
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for expected behavior,
[docs/ROADMAP.md](docs/ROADMAP.md) for plans, and
[Discussions](https://github.com/ys118/harnmem/discussions) for questions.

## Philosophy

HarnMem's core is deliberately small: one storage layout, one deterministic
retrieval engine, one write and consolidation lifecycle. The source of truth is
the file system, retrieval happens in the local process, and lifecycle decisions
stay explainable and reversible; that shape is a design constraint.

- Local-first, plain files: memories are Markdown with YAML frontmatter;
  indexes are derived and rebuildable.
- No services, daemons, vector databases or embedding models.
- `@harnmem/core` and `@harnmem/cli` have zero runtime dependencies and must
  stay that way.
- Adapters are thin. New harness adapters, retrieval/lifecycle improvements and
  eval coverage are welcome; core bloat is not.

If a feature does not belong in the core, it belongs in an adapter, the CLI or
an eval suite. PRs that bloat the core will likely be rejected.

## The One Rule

**You must understand your code.** If you cannot explain what your change does
and how it interacts with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated changes you cannot
explain is not. Label AI-generated issue or PR text.

## Contribution gate

All issues and PRs from new contributors are closed automatically by default.
This is a buffer, not a verdict: maintainers review auto-closed items daily and
reopen the ones that meet the quality bar; items that do not meet the bar will
not be reopened and may not receive a reply.

Approval happens through a maintainer reply on an issue:

- `lgtmi`: your future issues stay open.
- `lgtm`: your future issues and PRs stay open.

The command must be at the start of the reply (optionally after one or more
`@username` mentions) or at the end; `lgtmi` does not grant PR rights and only
`lgtm` does. The maintainer issuing the command must have write access to the
repository.

Approvals are recorded in `.github/APPROVED_CONTRIBUTORS` through an automation
pull request. The approval applies to future submissions once that pull request
is merged.

The gate is enforced by the `Issue gate`, `PR gate` and `Approve contributor`
GitHub Actions workflows.

## Quality bar for issues

Use one of the issue templates, and:

- Keep it to one screen. If it does not fit, it is too long.
- Write in your own voice; disclose AI-drafted text and keep it concrete.
- State the bug or request clearly and explain why it matters.
- Say whether you want to implement the change yourself.
- Never paste secrets, tokens, credentials or real personal memory content.
  Redact usernames, home paths and machine names from logs.

## Before opening a PR

Open an issue first. Do not open a PR until a maintainer has approved it with
`lgtm` in the command position above. Then:

1. Branch from `master` and keep the diff focused: one concern per PR.
2. Add or update tests. Tests must be deterministic: no network, no LLM calls,
   and no wall-clock dependence where it can be avoided (inject the clock).
3. Run and pass `pnpm -r build`, `pnpm -r typecheck` and `pnpm test`. If you
   touched the DSH adapter, also run `pnpm --filter dsh-harnmem test`; for the
   Grok adapter, `pnpm --filter grok-harnmem build && node --test
   packages/grok-harnmem/test/*.test.mjs`.
4. For retrieval, write, consolidation, extraction or scoring changes, run
   `pnpm eval:gate`. Eval corpora are generated, not committed: run
   `node evals/gen/generate.mjs` once after a fresh clone, then `pnpm eval`.
   Update `docs/design/03-retrieval.md`, `docs/design/05-evaluation.md` and
   `evals/results/eval-report.md` (regenerate with `pnpm eval:report`) together
   in the same PR.
5. Do not edit `CHANGELOG.md`: maintainers own it.
6. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
   `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
7. Keep repository text English. CJK is allowed only as data: evaluation
   lexicons, synonym tables, fixtures and CJK tokenization tests. No CJK prose.
8. Never commit a real `~/.harnmem` store, journal, log or personal data, and
   keep `@harnmem/core` and `@harnmem/cli` free of runtime dependencies; new
   dependencies need a discussion first.

## Merge policy

`master` is PR-only for everyone; direct pushes are not allowed, including for
maintainers' own changes. A PR is mergeable only when it has an approving review
from the repository owner (@ys118) and all required CI checks are green. Branch
protection is enforced by GitHub rulesets. Required checks are `build/test` on
ubuntu-latest with Node 22 and Node 24, `build/test` on windows-latest with
Node 22, and the `evaluation gates` job on ubuntu-latest.

The repository owner keeps the repository-admin bypass, because GitHub does not
allow approving your own pull request: the owner merges their own pull requests
with the bypass once required checks are green. The bypass is also the documented
escape hatch for emergencies; it never replaces review for outside
contributions.

Approval bookkeeping pull requests that only update
`.github/APPROVED_CONTRIBUTORS` are opened with the repository `GITHUB_TOKEN`
and therefore trigger no CI checks; the owner merges them with the bypass. They
only record an approval that was already granted in an issue comment.

## Project layout

All nine packages are published on npm: `@harnmem/core` 0.4.2,
`@harnmem/cli` 0.4.1, `pi-harnmem` 0.4.4, `dsh-harnmem` 0.4.2, `claude-harnmem`
0.4.3, `codex-harnmem` 0.2.3, `opencode-harnmem` 0.1.1, `grok-harnmem` 0.1.0 and
`cursor-harnmem` 0.1.1. The two newest adapters follow the same
zero-runtime-dependency, vendored-core rules as the others.

| Path | Package | What it is |
| ---- | ------- | ---------- |
| `packages/core` | `@harnmem/core` | Harness-agnostic engine: storage, indexing, retrieval, writing, consolidation, extraction, evaluation hooks. Zero runtime dependencies. |
| `packages/cli` | `@harnmem/cli` | The `harnmem` command: manage the store and migrate legacy harness memories. Depends only on `@harnmem/core`. |
| `packages/pi-harnmem` | `pi-harnmem` | pi extension: context injection, memory tools, `/memory`, session-end extraction. |
| `packages/dsh-harnmem` | `dsh-harnmem` | DSH plugin: system-prompt injection, `harnmem_*` tools, bounded session-end extraction. |
| `packages/claude-harnmem` | `claude-harnmem` | Claude Code plugin: `SessionStart` hook injection, bundled zero-dependency stdio MCP server, `/harnmem:memory`, detached session-end extraction. |
| `packages/codex-harnmem` | `codex-harnmem` | Codex CLI plugin: `SessionStart` `mcp_tool` hook injection, bundled stdio MCP server (7 tools), skill, rollout backfill. |
| `packages/opencode-harnmem` | `opencode-harnmem` | opencode v2 plugin: context-hook snapshot, five native tools, per-turn journaling. |
| `packages/grok-harnmem` | `grok-harnmem` | Grok CLI plugin: memory index through MCP `initialize.instructions`, six tools, `/grok-harnmem:memory`, `SessionEnd` extraction from `chat_history.jsonl`. |
| `packages/cursor-harnmem` | `cursor-harnmem` | Cursor desktop plugin: `beforeSubmitPrompt` snapshot injection, always-on rules, five-tool MCP server, detached `sessionEnd` extraction, installer with `--doctor`. |
| `evals` | - | Deterministic evaluation corpora (S1-S12), metrics, gates and ablation runner. |
| `prompts`, `data` | - | Prompt assets and synonym tables deployed to `~/.harnmem/` on first run. |
| `docs` | - | Design docs, research notes, roadmap and user guide. |

Adapter packages follow the `<harness>-harnmem` convention (`pi-harnmem`,
`dsh-harnmem`, `claude-harnmem`, `codex-harnmem`, `opencode-harnmem`,
`grok-harnmem`, `cursor-harnmem`); harness-neutral packages live under the
`@harnmem` scope. Adapter designs are in `docs/design/07`-`12`, with real-machine
probe records for the Codex, opencode, Grok and Cursor plugins under
`docs/research/`.

## Development setup

- Node.js 22.15+ (the CLI migration path needs `node:zlib` zstd for DSH session
  logs).
- pnpm 10 via `corepack enable`; the exact version is pinned by the
  `packageManager` field. Do not use npm or yarn for this repository.

```bash
corepack enable
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm test
```

`pnpm test` builds every package and runs all `node --test` suites (core engine,
CLI end-to-end tests and the six adapter suites).

## Code conventions

- TypeScript ESM, `strict` plus `noUncheckedIndexedAccess`; each package builds
  with plain `tsc` against `tsconfig.base.json`.
- Public API surface (`@harnmem/core` exports) and configuration keys are
  contracts: document and test changes to them.
- The store stays human-editable: Markdown entries with YAML frontmatter;
  indexes must be rebuildable from plain files.
- Do not log secrets or full memory bodies. Store and logs are user data.

## Adding a harness adapter

Read [`docs/design/07-adapter-contract.md`](docs/design/07-adapter-contract.md)
first, and open an issue before writing. An adapter:

- constructs the engine with a `harness` id, `cwd`, session id and optional LLM
  callback;
- injects `ensureContext()` into the harness system context byte-stably
  (rebuild only on session start, compaction, memory writes and day rollover);
- registers the five tool semantics (`write`, `search`, `read`, `forget`,
  `status`) and maps them to engine methods;
- calls `sessionEnd()` at session end, keeps extraction bounded (self-timeout)
  and read-only for subagents, and ships a README with install instructions and
  an end-to-end verification note.

The implemented Claude Code adapter (`docs/design/09-claude-adapter.md`, package
`packages/claude-harnmem`) is the natural starting point for a new harness. To
*import* a legacy memory store instead of wiring a runtime adapter, follow the
importer track in
[`docs/adapter-authoring.md`](docs/adapter-authoring.md).

## Blocking

Accounts are blocked for spam, high-volume agent-generated issue or PR traffic,
ignoring this document twice, or abusing maintainers and contributors.

## Maintainer process

PR-first flow: open a branch, push it, open a PR against `master`; the repository
owner (@ys118) approves it when it meets the bar and CI is green; squash and
merge unless the individual commits carry information worth preserving.

Approval comments (`lgtmi` / `lgtm`) are recorded by the automation workflow
described in [Contribution gate](#contribution-gate); merge the generated
bookkeeping pull request to activate the approval.

Releases: update `CHANGELOG.md` (`Added`, `Changed`, `Fixed`, `Removed`) and bump
all package versions in sync; merge the release PR, then tag `vX.Y.Z` and
push the tag. The release workflow builds, tests and publishes all packages
from GitHub Actions with npm provenance enabled when the repository secret
`NPM_TOKEN` is configured. Without that secret the workflow still runs every
check, skips publishing with a warning, and a maintainer publishes from a
trusted checkout instead: `npm login` once, then
`pnpm -r publish --access public --no-git-checks` from the tag. Release notes
come from the CHANGELOG section.

## FAQ

### Why are new issues and PRs auto-closed?

The tracker receives more than maintainers can review, and some reports are
agent-slung rather than shaped by the submitter. Auto-closing is a buffer so
maintainers can review in batches and reopen what is worthwhile.

### Why might a reply take time?

Triage and review happen in batches; expect days, not minutes. If something is
urgent, say so in the issue and keep it short, reproducible and free of personal
data.

### Why do some issues get no reply?

Unclear, duplicate or low-signal issues may be closed without discussion; that
protects time for reproducible bugs and thoughtful requests.

### Is this hostile to contributors?

No. It is a guardrail against burnout and tracker spam: short, concrete,
reproducible issues and thoughtful contributions are welcome; automated slop,
entitlement and high-volume low-effort reports are not.

### How is AI-generated text treated?

AI-assisted work is acceptable if a human understands and stands behind it.
Label AI-generated issue or PR text, and do not submit changes you cannot
explain; the One Rule applies to code and prose alike.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
