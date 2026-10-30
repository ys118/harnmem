# AGENTS.md

Instructions for AI coding agents (pi, Claude Code, Codex, DSH, opencode or any
other harness) working in this repository. `CONTRIBUTING.md` is the source of
truth; this file is the agent-facing contract.

## Workflow: worktree + branch + PR, never master

`master` is PR-only for everyone, maintainers included. Do not `git commit` or
`git push` on `master`, and do not use the repository-admin bypass to push
there.

For every change:

1. `git fetch origin`, then branch from `origin/master` in a separate worktree:
   `git worktree add ../<topic> -b <type>/<topic> origin/master`.
2. Keep the diff focused: one concern per PR.
3. Run the gates locally before pushing:
   `pnpm install --frozen-lockfile && pnpm -r build && pnpm -r typecheck && pnpm test && pnpm eval:gate`.
4. Commit with a Conventional Commit message (`feat:`, `fix:`, `docs:`,
   `test:`, `refactor:`, `chore:`).
5. Push the branch, then `gh pr create --base master` and wait for the required
   checks: `build/test (node 22, ubuntu-latest)`, `build/test (node 24,
   ubuntu-latest)`, `build/test (node 22, windows-latest)`, `evaluation gates`.
6. Merge only once those checks are green. GitHub does not allow approving your
   own pull request, so the repository owner merges their own PRs with the admin
   bypass (`gh pr merge --squash --admin`); every other contribution needs the
   owner's approving review.

Releases are a separate, explicit action after the PR merges: maintainers update
`CHANGELOG.md` and bump the package versions in a release PR, then tag `vX.Y.Z`
and push the tag. The `Release` workflow runs the full check suite and creates
the GitHub release from the matching `CHANGELOG.md` section.

## Non-negotiables

- `@harnmem/core` and `@harnmem/cli` have zero runtime dependencies.
- Tests must be deterministic: no network, no LLM calls, inject the clock where
  it matters.
- Never commit a real `~/.harnmem` store, journals, logs, secrets, credentials or
  personal memory content; redact home paths and usernames from fixtures.
- Keep repository text English. CJK is allowed only as data: evaluation
  lexicons, synonym tables, fixtures and CJK tokenization tests.
- Do not edit `CHANGELOG.md` or bump package versions outside a release PR.
- The store stays human-editable (Markdown plus YAML frontmatter) and indexes
  must be rebuildable from plain files.

## Verification

Report which commands you ran and their result in the PR description. A change
you cannot explain will be closed -- see "The One Rule" in `CONTRIBUTING.md`.
