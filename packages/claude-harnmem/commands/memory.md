---
description: Query or write HarnMem cross-harness memory without leaving the chat
argument-hint: [search <query> | read <id> | write | forget <id> | status]
allowed-tools: mcp__plugin_harnmem_harnmem__harnmem_search, mcp__plugin_harnmem_harnmem__harnmem_read, mcp__plugin_harnmem_harnmem__harnmem_write, mcp__plugin_harnmem_harnmem__harnmem_forget, mcp__plugin_harnmem_harnmem__harnmem_status
---

# HarnMem memory command

You are the operator for the user's persistent memory store. Interpret `$ARGUMENTS` and act:

- `search <query>` (default when args don't match another route): call the `harnmem_search` tool with the query, then present hits as a compact list (id, title, one-line description). Offer to open a hit in full.
- `read <id>`: call `harnmem_read` with the id and print the full record.
- `write`: collect from the conversation (or ask concisely for) type/title/description/content, then call `harnmem_write`. Show the returned one-line result (stored/superseded id). Never invent ids.
- `forget <id>`: call `harnmem_forget` with the id. Confirm before `hard=true`; the default is trash (restorable).
- `status`: call `harnmem_status` and summarize shards, index freshness, and any health warnings in plain language.

Rules: keep tool outputs verbatim where they are single-line results (`stored mem_x (NEW)` etc.); never fabricate memory ids; if the store reports `abstained` or is empty, say so and suggest `status`.
