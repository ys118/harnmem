---
name: harnmem-recall
description: Recall durable cross-harness memories (user preferences, feedback, project decisions, references) stored by HarnMem. Use when the user references earlier sessions, asks what you remember, or before re-asking about a known preference or decision.
---

# HarnMem recall

The session-start memory index is injected through the MCP `harnmem` server's
`initialize.instructions`, and it is deliberately small: Grok truncates the
aggregate "MCP servers connected" reminder (about 4 KB), so the index may have
been cut off.

Before answering questions about past decisions, preferences, or project facts:

1. Call `memory_search` (`harnmem__memory_search`) with a natural-language query.
   Chinese is matched by bigram, so a Chinese query is fine.
2. If the search is unsatisfying but the memory context exists, call
   `memory_context` (`harnmem__memory_context`) to fetch the full hot index that
   was truncated at session start.
3. Open a specific hit with `memory_read` before quoting details.

Do not invent memory ids. Prefer the store over guessing; say plainly when the
store has nothing relevant.
