# @harnmem/core

The harness-agnostic memory engine behind HarnMem.

`@harnmem/core` implements the file-native memory store, the local retrieval
engine and the write/lifecycle pipeline. It has **zero runtime dependencies**
(Node.js built-ins only) and no external services: the store under
`~/.harnmem/` is the source of truth, and indexes are derived and rebuildable.

Typical consumers are harness adapters (for example
[`harnmem-pi`](../harnmem-pi)) and the [`@harnmem/cli`](../cli) migration tool.

## What it provides

- `HarnMem` facade: `open`, `ensureContext`, `search`, `read`,
  `write`, `importRecords`, `forget`, `restore`, `consolidate`, `stats`,
  `sessionEnd`.
- A plain-file store: one Markdown file with YAML frontmatter per memory, split
  into user scope (`memories/user/`) and project scopes
  (`memories/projects/<projectId>/`).
- Deterministic retrieval: CJK-aware tokenization (character bigrams), BM25F
  field weighting, link diffusion, MMR, token-budgeted injection, and
  abstention when evidence is weak.
- Write lifecycle: ADD-only with bi-temporal supersede, mechanical
  dedupe/merge with provenance, confidence gates, soft delete and restore.
- Governance: value scoring, Ebbinghaus-style retention, archival and capacity
  limits.
- Extraction helpers: transcript digest construction, prompt-asset loading and
  deployment, structured extraction response parsing.

## Usage

```ts
import { HarnMem } from "@harnmem/core";

const mem = await HarnMem.open({
  harness: "my-harness",
  cwd: process.cwd(),
  sessionId: "session-1",
  llm: async ({ system, prompt }) => callYourModel(system, prompt),
});

const block = await mem.ensureContext("session_start");
// inject block.text into the system prompt (keep it byte-stable)

await mem.write({
  type: "feedback",
  title: "Never force-push main",
  description: "Shared repository requires PRs.",
  content: "**Why:** ...\n**How to apply:** ...",
});

const result = await mem.search({ query: "force push", limit: 5 });
await mem.sessionEnd({ messages, reason: "quit" });
```

See the repository [README](../../README.md) and
[design docs](../../docs/README.md) for the data model, retrieval formula and
adapter contract.

## Requirements

- Node.js >= 18 for the engine (adapters may require newer runtimes).
- No network access, no external services, no native modules.

## License

MIT
