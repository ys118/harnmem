<!--
Read CONTRIBUTING.md before opening this PR. New contributors must be approved
by a maintainer with `lgtm` before a PR stays open; unapproved PRs from new
contributors are closed automatically.
-->

## Summary

<!-- What does this PR change, and why? One paragraph, no fluff. -->

Closes #

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Documentation
- [ ] Tests / evals
- [ ] Refactor / chore (no behavior change)

## Attestation

- [ ] I understand every change in this PR and can explain how it interacts
      with the rest of the system (the One Rule in CONTRIBUTING.md).

## AI assistance

<!-- Required. Write "none", or describe what was AI-generated (code, docs,
PR text) and confirm that you reviewed and understand it. AI-assisted work is
fine when it is disclosed. -->

## What changed

<!-- Concrete bullets: files, behavior, user-visible effects. -->

## Why

<!-- The problem this solves. Link the approved issue. -->

## How it was tested

<!-- Exact commands and their results. Example:
pnpm -r build
pnpm -r typecheck
pnpm test          # pass
pnpm eval:gate     # functional gates pass (perf items are advisory)
-->

## Behavior and compatibility

<!-- User-visible behavior changes, public API or config changes, store schema
or migration impact. Write "none" if nothing changes. -->

## Checklist

- [ ] `pnpm -r build`, `pnpm -r typecheck` and `pnpm test` pass locally.
- [ ] For retrieval, write, consolidation, extraction or scoring changes:
      `pnpm eval:gate` passes and `docs/design/03-retrieval.md`,
      `docs/design/05-evaluation.md` and `evals/results/eval-report.md` are
      updated together.
- [ ] Tests are deterministic: no network, no LLM calls, injected clock where
      needed.
- [ ] Public API and configuration changes are documented.
- [ ] `CHANGELOG.md` is untouched (maintainers own it).
- [ ] No secrets, real personal memory content, absolute home paths or CJK
      prose added; repository text is English.
- [ ] `@harnmem/core` and `@harnmem/cli` still have zero runtime dependencies.
- [ ] Commits follow Conventional Commits.

## Notes for reviewers

<!-- Tradeoffs, follow-ups, or anything reviewers should know. -->

**Merge policy:** merging requires an approving review from @ys118 (repository
owner) and green required CI checks. `master` is PR-only; direct pushes are not
allowed.
