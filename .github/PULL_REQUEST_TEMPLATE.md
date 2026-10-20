## Summary

<!-- What does this PR change, and why? Link related issues with "Closes #123". -->

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Documentation
- [ ] Tests / evals
- [ ] Refactor / chore

## Checklist

- [ ] `pnpm -r build && pnpm -r typecheck && pnpm test` pass locally.
- [ ] For retrieval/write/consolidation changes: `pnpm eval:gate` passes (advisory perf items may remain).
- [ ] Tests are deterministic (no network, no LLM calls, injected clock where needed).
- [ ] Public API/types and configuration changes are documented; `CHANGELOG.md` updated for user-visible changes.
- [ ] No secrets, real personal memory content, or CJK prose added; repository text is English.
- [ ] `@harnmem/core` and `@harnmem/cli` still have zero runtime dependencies.

## Notes for reviewers
