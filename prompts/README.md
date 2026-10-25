# prompts/ — model prompt assets

> Version: v1 · One shared prompt set for every harness (pi / DSH / Claude Code).
> These files are **plain-text assets** loaded by `packages/core/src/assets.ts` on every extraction/consolidation; the first `HarnMem.open()` copies them into editable copies (`~/.harnmem/prompts/`, `~/.harnmem/data/`). No network, no external references, no includes.

## Deployment and editable copies

- On first engine open: `deployDefaultAssets(home)` copies the package/repository-root `prompts/*.md|*.txt` and `data/*.txt|*.tsv` into `<home>/prompts`, `<home>/data`; **existing files are never overwritten**. Synonym tables are named `synonyms.txt` or `synonyms.<lang>.txt` (e.g. `synonyms.zh.txt`): every such file found in `<home>/data` and the repository `data/` is loaded and merged, with the `<home>` copy winning per filename. `harnmem synonyms suggest --write` appends reviewed groups to `<home>/data/synonyms.<lang>-suggested.txt`, which the loader treats as one more language file (delete the file or a line to retire a suggestion — the repository is never modified).
- Asset-root discovery order: the `HARNMEM_ASSETS_DIR` environment variable → walk up to 8 levels from the directory containing `assets.ts` looking for a directory that contains `prompts/extract.md` → if not found (single-file bundle), use the built-in default prompt in `packages/core/src/extract.ts`.
- Load priority: `<home>/prompts/<name>.md` → repository/package default (`readAssetRaw`); the user's `<home>` copy overrides, and deleting the copy falls back to the built-in/default.
- When changes take effect: files are re-read on every extraction/consolidation, no restart needed; an edit applies to the next extraction (byte stability of injected text and the system prompt is guaranteed by engine snapshots, see 03 §5.2).
- Names: extraction = `extract.md`; consolidation = `consolidate-digest.md`; synonym suggestions = `synonyms.md` (read by the `harnmem synonyms suggest` CLI command, not by the engine's extraction path); migration = `migrate.md` (an agent-facing recipe for legacy stores the deterministic importers cannot parse — deployed for discoverability, never loaded by the engine); `write-policy.md` is write-discipline text for humans and adapters, and the engine does not load it today (injection is a v0.2 consideration).

## File inventory

| File | Purpose | Caller | Budget (engine accounting) |
|---|---|---|---|
| `extract.md` | Background extraction: conversation → candidate-memory JSON | `LlmPort.generate()`, triggered by the engine after a conversation turn | system ≤ 1800 tok (measured 1763); template ≤ 120 tok (measured 85; injected data excluded) |
| `write-policy.md` | Write-discipline text, **no LLM call**, injected verbatim into the memory block | Injection layer (within the `injectTokens` budget) | ≤ 220 tok (measured 192) |
| `consolidate-digest.md` | Topic consolidation: a group of memories → one digest page | `LlmPort.generate()`, explicit or background call | system ≤ 650 tok (measured 398); template ≤ 50 tok (measured 32) |
| `synonyms.md` | Synonym-table suggestions: local memories → proposed `canonical<TAB>synonyms` groups | `harnmem synonyms suggest` only (`packages/core/src/suggest.ts`); the engine never calls it | system ≤ 1100 tok (measured 338); template ≤ 100 tok (measured 44; injected data excluded) |
| `migrate.md` | Migration recipe: an old memory store → HarnMem `ImportRecord[]` JSON, for the user's own agent | The user's agent reads it (documented in `docs/design/10-migration-onboarding.md` §8 and user-guide §8); **never engine-loaded** | not budgeted (human/agent-facing recipe, not an extraction prompt) |

Engine token estimate: `tokens ≈ 0.75 × CJK chars + 0.3 × ASCII chars`; measurements above were taken on 2026-10-20 after the English rewrite with `estimateTokens` from `packages/core`. CI validates budgets with the same formula and fails when exceeded.

## File format (loading contract)

```text
<!-- version: 1 -->          ← optional; positive integer, defaults to 1 (diagnostics only, monotonicity not enforced)
<!-- prompt: extract -->      ← optional metadata comment
<!-- budget: ... -->          ← optional human note
<!-- placeholders: ... -->    ← optional; declares placeholders

## system
<system prompt body>

## user
<user template body, containing {{placeholder}}>
```

Parsing rules (implementation: `parsePromptAsset` in `packages/core/src/assets.ts`):

1. UTF-8; `\r\n` → `\n`; all `<!-- ... -->` comments (including multi-line ones) are stripped before parsing — comments are **never sent to the model**.
2. Role segmentation: a whole line matching `^\s*##\s+(system|user)\s*$` (surrounding whitespace tolerated). Markers may appear 0, 1, or several times: multiple occurrences are joined in order with a blank line; body text before the first marker joins the system part; **no marker at all = a legacy single-part file whose whole content is the system prompt** (so plain-body files such as `write-policy.md` can be stored as-is).
3. The `## user` section may be absent: the engine then uses the built-in fallback user prompt (`legacyUserPrompt` in `extract.ts`, containing Project / Session date / Existing memories / Transcript digest).
4. Placeholders: plain literal substitution of `{{name}}` (split/join, single pass per variable, not recursive); **the engine substitutes only in the user section**; unknown placeholders are left as-is and missing variables do not error (they are not load errors).
5. Failure semantics: a missing asset → the built-in default prompt in `extract.ts`; parsing is lenient and **not fail-fast**. A runtime LLM-call exception → that extraction round returns empty and records `failed` (v0.1 has no retry).

## Placeholder table

| Prompt | Placeholder | Content injected by the engine (format must be exact) |
|---|---|---|
| `extract.md` | `{{observation_date}}` | `YYYY-MM-DD` (the session observation date, passed in as `input.date`) |
| | `{{existing_memories}}` | One line each: `- [mem_id] (type) title — description`; at most 60; `(none)` when there are no memories |
| | `{{transcript}}` | One line each: `User: …` / `Assistant: …` / `Tool: …`; whitespace collapsed to single spaces; each entry truncated to 1200 characters; filled newest-to-oldest, total ≤ 6000 characters |
| `consolidate-digest.md` | `{{topic}}` | Topic name (`category ?? tags[0] ?? type`, in the user's language as-is) |
| | `{{memories}}` | One block per memory: `### [mem_id] (type) valid_from=YYYY-MM-DD` + `title:` + `description:` + `content:` (first 800 characters of the body); at most 12 per batch, blocks separated by blank lines |
| `synonyms.md` | `{{language}}` | Language tag written from `--language` (default `zh`), e.g. `Language: zh` |
| | `{{terms}}` | One line: `term (count)` pairs joined with `, `, most frequent first; at most 120 terms; `(none)` when the local corpus harvest is empty |
| | `{{existing}}` | One line per group in force: `canonical = synonym, synonym`; at most 40 groups; `(empty)` when no table is loaded |
| | `{{samples}}` | One line each: `- title — description` (at most 16 records, each ≤ 160 characters); optional `- [session] text` lines (at most 8, each ≤ 140 characters); `(empty)` when there is nothing to sample |
| `migrate.md` | `{{source}}` | The legacy store path or service name the user wants migrated (substituted by the user's agent) |
| | `{{target_home}}` | The HarnMem home directory, e.g. `~/.harnmem` |
| | `{{harnmem}}` | The CLI invocation to use, e.g. `harnmem` or `npx harnmem` |

> The input rendering format is a **contract between prompts and the engine**: confirm the rendering format has not changed before editing a prompt; a rendering-format change must bump the version.

## Versioning and changes

- Any change affecting model behavior or output → `version` +1.
- Breaking changes (output schema, placeholder set, number of role sections, language policy) → major version bump and a minimum version declared by the engine such as `extract@2`.
- A change must also update `docs/research/prompt-review.md` (evidence/failure mode for each line) and the consistency check in `docs/design/04-write-and-lifecycle.md` §3.3.
- Frozen versions are never edited in place: use git history; `extract@1` is the first production version.

## Language policy

- Prompt text is written in English so a single asset serves every harness; `type`/`category`/`scope`/JSON field names remain English enums — aligned with `packages/core/src/types.ts`.
- The language of recorded memories follows the **conversation's primary language**: Chinese conversation → Chinese memories, English conversation → English memories; identifiers/commands/paths are not translated.
- The same prompt must work bilingually (do not hard-code Chinese examples as the only output standard); examples only demonstrate the shape.

## Engine-side fallbacks (not the prompt's job)

The prompt is only responsible for "extracting well"; the following is enforced by the engine during validation/persistence so the prompt does not need to grow:

- JSON parse failure / model exception → that round returns an empty result and records `failed` (v0.1 does not retry);
- Parsing requires `title` + `content`; drop the item if either is missing; `type` outside the whitelist falls back to `project`; `scope` is only user/project;
- Candidate-level truncation: `title` 200, `description` 200, `content` 8000 characters; `type` whitelist, `tags/entities` ≤12, `links` ≤8, `evidence` ≤3, `supersedes` accepts only `mem_` + 26-character ids;
- `importance` clamped to 0–10 (default 5), `confidence` clamped to 0–1 (default 0.7);
- `maxPerRun = 6` (truncated by `importance × confidence`, keeping the highest); `confidence < 0.5` is not persisted;
- At persistence the engine re-validates: `title` ≤ 80 characters, `description` ≤ 200, `content` ≤ 64 KB; `links`/`supersedes` may only reference existing memory ids, unknown ids are dropped;
- `tags` are lowercased, kebab-cased, and deduplicated; secrets/credentials get a second redaction pass in the engine (the prompt is one line of defense, not the only one);
- `noop_reason` is truncated to 120 characters; empty arrays are not written to disk.

## Prompts that do not live here

The `evals/` judge/scenario prompts and harness-specific prompts in `packages/*/adapters` are kept out of this directory so evaluation specifics never couple into production assets.
