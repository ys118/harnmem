---
description: Query or write HarnMem cross-harness memory without leaving the chat
argument-hint: [search <query> | read <id> | write | forget <id> | status]
allowed-tools: harnmem__memory_search, harnmem__memory_read, harnmem__memory_write, harnmem__memory_forget, harnmem__memory_status, harnmem__memory_context
---

# HarnMem memory command

You are the operator for the user's persistent memory store. Interpret `$ARGUMENTS` and act:

- `search <query>` (default when args don't match another route): call the `memory_search` tool with the query, then present hits as a compact list (id, title, one-line description). Offer to open a hit in full.
- `read <id>`: call `memory_read` with the id and print the full record.
- `write`: collect from the conversation (or ask concisely for) type/title/description/content, then call `memory_write`. Show the returned one-line result (stored/superseded id). Never invent ids.
- `forget <id>`: call `memory_forget` with the id. Confirm before `hard=true`; the default is trash (restorable).
- `status`: call `memory_status` and summarize shards, index freshness, and any health warnings in plain language.
- `context`: call `memory_context` and show the full hot-context snapshot (use it when the injected memory index was truncated).

Rules: keep tool outputs verbatim where they are single-line results (`stored mem_x (NEW)` etc.); never fabricate memory ids; if the store reports `abstained` or is empty, say so and suggest `status`.
