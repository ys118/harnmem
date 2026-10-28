---
name: harnmem
description: Use HarnMem cross-harness memory — search before re-asking for known user preferences or decisions, and store durable preferences/feedback/decisions worth carrying across sessions and harnesses.
---

# HarnMem memory (Codex)

You have persistent cross-harness memory through the `mcp__harnmem__*` tools
(shared with the user's other coding agents — Claude Code, DSH, pi). A memory
snapshot is already injected at session start; the tools let you go deeper.

## When to search (`memory_search`)

- The user references a past decision, preference, or setup ("like before",
  "as usual", "the rules from last time") and the injected snapshot does not
  answer it.
- Before asking the user to re-state a preference that is plausibly already
  stored (editor, package manager, deploy flow, review style).
- When starting work on a project you have touched before: search the project
  name or repo for decisions and guardrails.

## When to write (`memory_write`)

Store only durable, reusable facts — never transient task state:

- user preferences and workflow rules (type `user`)
- corrective feedback with its **Why** and **How to apply** (type `feedback`)
- project decisions, guardrails, environment quirks (type `project`)
- pointers to external references (type `reference`)

Do not store: the current task's intermediate state, file listings, anything
already tracked in the repo, or secrets/credentials — never store secrets.

## Hygiene

- `memory_write` returns one line (`NEW` / `SKIP` / `MERGE` / `SUPERSEDE` /
  `LINK`) — trust it; do not re-write to "confirm".
- Prefer one specific record over a sprawling essay; supersede outdated
  records instead of writing contradictory new ones.
- `memory_forget` moves records to trash (recoverable); `hard=true` is
  irreversible and needs an explicit user request.
- `memory_status` shows store health when something looks off.
