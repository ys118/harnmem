# Contributing to HarnMem

Thanks for your interest. HarnMem is a small, deliberately boring system: plain
files in a home directory, a deterministic local retrieval engine, and thin
adapters for coding harnesses. That shape is a design constraint, not an
accident, so contributions that keep it simple are especially welcome.

By participating you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).
Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## Project layout

| Path | Package | What it is |
| ---- | ------- | ---------- |
| `packages/core` | `@harnmem/core` | Harness-agnostic memory engine: storage, indexing, retrieval, writing, consolidation, extraction, evaluation hooks. Zero runtime dependencies. |
| `packages/cli` | `@harnmem/cli` | The `harnmem` command: inspect/manage the store and migrate legacy harness memories. Depends only on `@harnmem/core`. |
| `packages/harnmem-pi` | `harnmem-pi` | pi coding-agent extension: context injection, memory tools, `/memory` command, session-end extraction. |
| `evals` | - | Deterministic evaluation corpora (S1-S12), metrics, gate and ablation runner. |
| `prompts` | - | Extraction/consolidation prompt assets deployed to `~/.harnmem/prompts/` on first run. |
| `data` | - | Synonym tables and other data assets. |
| `docs` | - | Design docs, research notes, and the user guide. |

Future adapters (DSH, Claude Code) are designed in `docs/design/08` and `09`;
their packages are not implemented yet.

## Development setup

Requirements:

- Node.js **22.15+** (the core engine supports 18+, but the CLI needs
  `node:zlib` zstd for DSH session logs, and the pi extension targets the pi
  runtime).
- pnpm 10 via `corepack enable` (the exact version is pinned by the
  `packageManager` field).

```bash
corepack enable
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm test            # builds @harnmem/core, then runs node --test (19 tests)
```

Evaluation (deterministic, no network, no LLM):

```bash
node evals/gen/generate.mjs --check   # verify generated corpora match the committed generator
pnpm eval                             # all suites, report to stdout
pnpm eval:gate                        # fail on hard gate regressions; perf gates are advisory
```

The evaluation harness is part of the contract: a change that lowers recall,
leaks memories across scopes, or breaks KV-cache stability should show up there
and should be called out in the PR.

## Making a change

1. Open an issue for anything non-trivial (bug reports and feature requests
   have templates). Small fixes can go straight to a PR.
2. Branch from `main` and keep the diff focused.
3. Add or update tests. Tests must be deterministic: no network, no LLM calls,
   no dependence on wall-clock time where it can be avoided (inject `now`).
4. Update documentation when behavior or config keys change. Docs are written
   in English.
5. Run `pnpm -r build && pnpm -r typecheck && pnpm test` and, for changes that
   touch retrieval/writing/consolidation, `pnpm eval:gate`.
6. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
   messages (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).

### Code conventions

- TypeScript, ESM, `strict` plus `noUncheckedIndexedAccess`.
- `@harnmem/core` and `@harnmem/cli` must stay free of runtime dependencies
  (Node.js built-ins only). New dependencies need a discussion first: the
  zero-dependency property is a feature.
- Repository text (docs, comments, log/error messages, issue templates) is
  English. CJK strings are allowed where they are *data*: evaluation lexicons,
  synonym tables, and tests that specifically exercise CJK tokenization or
  retrieval. Do not add CJK prose.
- Never log secrets or full memory bodies. User data stays local; do not commit
  a real `~/.harnmem` store or copies of real harness memory files (the
  `.gitignore` covers the common cases).
- Keep the memory store human-editable: memory entries are Markdown with YAML
  frontmatter; derived indexes must be rebuildable from the plain files.

### Adding a harness adapter

Read [`docs/design/07-adapter-contract.md`](docs/design/07-adapter-contract.md)
first. An adapter should:

- construct `HarnMem` with a `harness` id, `cwd`, session id, and an optional
  LLM callback;
- inject the result of `ensureContext()` into the harness's system context in a
  byte-stable way (rebuild only on session start, compaction, memory writes,
  and day rollover);
- register the five tool semantics (`write`, `search`, `read`, `forget`,
  `status`) and map them to `HarnMem` methods;
- call `sessionEnd()` at the end of a session and keep extraction strictly
  bounded (self-timeout) and read-only for subagents;
- ship a package README with install instructions and an e2e verification note.

## Pull request checklist

- [ ] Tests pass locally (`pnpm test`), eval gate passes for retrieval changes.
- [ ] New behavior is documented and, when user-visible, in `CHANGELOG.md`.
- [ ] No personal data, secrets, absolute local paths, or CJK prose added.
- [ ] Public interfaces (`@harnmem/core` exports) are intentional and typed.
- [ ] Commits follow Conventional Commits.

## Release process (maintainers)

1. Update `CHANGELOG.md`, bump versions in the affected `package.json` files.
2. Commit `chore(release): vX.Y.Z`, tag `vX.Y.Z`, push the tag.
3. The release workflow builds, tests, and publishes the packages
   (`@harnmem/core`, `@harnmem/cli`, `harnmem-pi`) with npm provenance enabled.
   Publishing requires membership in the `@harnmem` npm org and an `NPM_TOKEN`
   repository secret.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
