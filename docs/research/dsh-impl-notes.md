# DSH adapter implementation notes (fact verification and real-machine test plan)

> Purpose: pin every judgment in `docs/design/08-dsh-adapter.md` to evidence, and list what still needs **real-machine verification** given this machine's condition (the current DSH install has no resolvable `@deepseek-ai/*`).
> Collected: 2026-10-20. Machine: Windows 11 x64.
> Evidence labels: `[V]` = directly confirmed by reading source/config/command output; `[I]` = derived from the API shape; `[U]` = unverified, listed in the §4 test plan.

## 1. Environment matrix `[V]`

| Item | Value | Evidence |
|---|---|---|
| DSH installed version | **0.2.1-rc.2** | `dsh --version` → `0.2.1-rc.2` (`<DSH install>\resources\runtime\cli\bin\dsh.cmd`) |
| Bundled runtime | Node 24.21.0 / pnpm 11.28.5 | `resources\runtime\versions.json` |
| Desktop app version | 0.2.1-rc.2 | `resources\runtime\primary-runtime\runtime.json:2` |
| Local source checkout | **0.1.3-alpha.1** (older than the runtime) | `~/projects/deepseek-harness/apps/cli/package.json` |
| Active memory plugin | dsh-auto-memory **0.9.0** | `~/.dsh/profiles/desktop/package.json` |
| Plugin source (single-file bundle) | `~/.dsh/profiles/desktop/node_modules/dsh-auto-memory/lib/index.js` (2414 lines) | `Get-Content` + `ReadAllLines` measured |
| Profile composition | hoisted pnpm; `autoInstallPeers:false`; `minimumReleaseAgeExclude: dsh-auto-memory@0.9.0, billion-context@0.1.201` | `~/.dsh/profiles/desktop/pnpm-workspace.yaml` |
| Profile dependencies | `billion-context 0.1.201`, `dsh-auto-memory 0.9.0`, `dshmarket ^1.66.35`; `dsh.profile.bundles` has 9 entries | `~/.dsh/profiles/desktop/package.json` |
| Host package resolution | The profile's `@deepseek-ai/*` are **dead junctions** (pointing at a no-longer-existing `%APPDATA%\nvm\v24.9.0\node_modules\@deepseek-ai\dsh\node_modules\...`); `desktop/node_modules/@deepseek-ai` contains only real directories `cosmokit` and `schemastery` | `Get-Item` → `LinkType=Junction, Target=..., target exists: False` |
| asar size | 182,794,869 B (`resources\app.asar`; the runtime `@deepseek-ai` packages live inside this archive, with no unpacked directory) | `Get-Item` |

## 2. Verified facts `[V]`

### 2.1 Plugin package and exports

| Fact | Evidence |
|---|---|
| Named exports `name/inject/Config/apply`, no default | `lib/index.js:2365-2366, 2367, 2376, 2414`; last line of `lib/index.d.ts`: `export { Config, apply, inject, name }` |
| `inject = ["tools","systemPrompt"]`, `llm` is not in inject (uses `ctx.get`) | `lib/index.js:2366, 1807` |
| Config is declared with schemastery; defaults live only in the schema | `lib/index.js:2367-2375` (`maxBytes/memoryDir/enableUserScope/autoSummarize/autoSummarizeMaxMemories/autoSummarizeMaxTokens/staleAfterDays`) |
| Inside `apply`, `rootDir = config.memoryDir ?? join(resolveDshHome(),"memory")` | `lib/index.js:2377` |
| `package.json` needs `dsh.manifestVersion:1` + `dsh.bundle.patch`; the 3-line patch file that `bundle.patch` points at is: `- insert: [{id: auto-memory, name: dsh-auto-memory}]` | the `dsh` block of `dsh-auto-memory/package.json`; `dsh-auto-memory/cordis.patch.yml` (comment: the insert row's name must be the npm package name, omitting config uses the plugin schema, and the user profile patch replaces the whole table by id) |
| Profile composition order: `dsh.profile.bundles` layers → `cordis.patch.yml` → `--patch` | `~/.dsh/profiles/desktop/cordis.yml:1-5` (`[]` + comment) |
| The patch file is "a top-level YAML array: id-targeted overrides / disable / insert lists; `!!js` allowed" | `~/.dsh/profiles/desktop/cordis.patch.yml:1-3` |
| Install command = pnpm forwarding: `dsh plugin --profile <p> add <pkg>`; `--profile` initializes on first use | `dsh plugin --help` verbatim: `manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory` |

### 2.2 Injection

| Fact | Evidence |
|---|---|
| The only injection = one section, `order: 4000`, text as a function (re-evaluated every step) | `lib/index.js:2404-2408`; `text: (context) => audit.text(context.agent?.session.header.cwd, context.agent?.session.id)` |
| Section content template (`<memory_context>` + anti-prompt-injection statement + `# Persistent memory index` + User/Project sections + write discipline) | `lib/index.js:1249-1351` (`MEMORY_SECTION`) |
| Empty store injects 0 bytes (the section returns an empty string) | the section generation path at `lib/index.js:1249-1351`; the "no section when there is no memory" semantics is in research report A4 |
| Index budget and truncation: `maxBytes` minus policy/overhead, keeping lines in order + a tail truncation notice | `lib/index.js:1247-1351` |
| Brace neutralization (`{{`→`{ {`) to prevent template breakage | `neutralizeBraces` in `lib/index.js` (measured, research report A4) |
| MEMORY.md is derived: fully rebuilt after every write/delete; ordering pinned → memoryScore (day granularity) → name | `lib/index.js:290-302` (`renderIndexBody`), `1249` |
| Single-entry file frontmatter: `name/title/description/type/pinned/disabled/importance/created/updated/lastRead/reads` | `parseMemory` 229-257 / `serializeMemory` 259-273 |

### 2.3 Events and LLM

| Fact | Evidence |
|---|---|
| Session-end landing point = `agent/disposed` (background consolidation is attached here) | `lib/index.js:1797` |
| Per-event session capture = `ctx.on("session/event", ...)` (`user/message` with `source.kind==="user"`, `assistant/message`) | `lib/index.js` from line 1772 |
| LLM = `ctx.get("llm")` + `llm.stream({provider,model,messages,maxTokens,sessionId,signal})` + `BlockAssembler` | `lib/index.js:1807, 1814, 1829` |
| `assembler.finish.kind` has been observed as `"error"` / `"aborted"`; the success variant is not asserted in the 0.9.0 source | `lib/index.js:1831-1835` |
| Plugin unload uses `ctx.effect(function*(){ yield async () => ... })` to wait for in-flight tasks | `lib/index.js:1875` |
| Subagent gate: dual fields `delegationDepth`/`subagentDepth` (both may be undefined) | near `lib/index.js:341`; `delegationDepth` was FOUND in the 0.2.1 asar probe |
| Never write custom session events (third-party event types make resume refuse the session) | design comment at `lib/index.js:112` |
| Access `$DSH_HOME` with `node:fs`, not `ctx.fs` (the sandbox write roots do not include home) | `lib/index.js:105-107` |

### 2.4 Runtime API names (0.2.1 asar string probe)

A read-only `findstr /M` probe over `resources\app.asar` (binary tail data; it **can only prove that a string exists**, not the signature/namespace):

| String | Result |
|---|---|
| `agent/created` / `agent/disposed` / `agent/pre-step` / `agent/turn-stopping` / `agent/request` / `agent/request-error` | FOUND |
| `session/event` / `session/disposed` / `session-start` | FOUND |
| `agent/session-start` | **not found** (only the `session-start` substring) |
| `system-prompt/assemble` | FOUND |
| `compaction/summary` / `turn/end` / `delegationDepth` | FOUND |
| `systemPrompt.section` / `tools.register` / `defineTool` / `ctx.systemPrompt` | FOUND |

Source-side cross-reference (checkout 0.1.3-alpha.1): `packages/core/agent/src/runtime-types.ts:204` (`agent/created`), `:213` (`agent/disposed`), `:262` (`agent/session-start`), `:276` (`agent/pre-step`), `:289` (`agent/request`), `:333` (`agent/turn-stopping`); `docs/subsystems/session.md:1111-1127` (`session/event` emit signature `(session, event)`); `docs/subsystems/compaction.md:13-19` (`compaction/start|summary|end` events and payloads), `:130` (`ctx.compaction` seam is an optional capability).

### 2.5 Migration data and project identity

| Fact | Evidence |
|---|---|
| dsh data layout: `_user/MEMORY.md + entries`, `--<projectKey>--/` project layers, `audit.jsonl` injection audit (each line `ts/sessionId/cwd/injected/truncated/bytes`) | `~/.dsh/memory/` (`_user` 2 entries, `--D-projects-example-project--` 24 entries, `<downloads-slug>` 4 entries, audit 23,288 B) |
| `projectKey` algorithm (`/ \ :`→`-` collapsing; illegal chars→`~XXXX`; ≤251; `--<slug>--`) is isomorphic with session directories and **cannot be uniquely inverted** | `lib/index.js:134-153` |
| The correct way to recover the real path = read the `cwd` in the header of that key's session log | auto-memory's `import-claude` precedent: read the first 262144 B of `~/.claude/projects/<slug>/*.jsonl`, line-by-line `JSON.parse`, and take the first `cwd`, `lib/index.js:1883-2135` (the cwd extraction is at 1974-2006) |
| DSH session logs are `session.v4.jsonl.zstd` (zstd-compressed) | measured filenames under `~/.dsh/sessions/--D-projects-example-project--/` |
| pi data: `MEMORY.md` 19,895 B (comment markers `<!-- YYYY-MM-DD[ HH:MM:SS] [8hex] -->` + `#tag` + `[[wiki]]`), `SCRATCHPAD.md` 13 B, 9 `daily/*.md`, `recovery/*.json` | `~/.pi/agent/memory/` |
| The ZCode data directory does not exist (only the mechanism note `zcode-memory-mechanism.md`; key = `slug-sha256(lowercased normalized path)[:16]`) | `Test-Path ~/.zcode` → False |
| Frozen types and the old implementation have drifted: `tsc -p packages/core/tsconfig.json --noEmit` reports about 35 errors | Representative: `config.ts:43` `autoCapture` is not in `WriteConfig`, `config.ts:51` `maxMemoriesPerProject` is not in `GovernanceConfig`, `consolidate.ts:46/48` treat `merged`/`archived` as numbers, `consolidate.ts:57/58/62` use report fields that do not exist (`scanned/details/duplicatesMerged`), `extract.ts:155` `maxPerSession` is not in `WriteConfig`, `retrieval.ts:67` weights are partially type-incompatible; `packages/core/src/harnmem.ts` does not exist |

## 3. Inferred items `[I]`

- The mapping of the six hooks to the frozen API (`open` → `ensureContext` → `search/read/write/forget/stats` → `sessionEnd` → `close`): the `HarnMem` facade's method set is in `07-adapter-contract.md:7-29`, and the signatures in `types.ts` correspond one-to-one; the lifecycle only has the two sides `agent/created`/`agent/disposed`, and `ensureContext` is subdivided by `ContextReason`.
- The field shape of `defineTool({name,description,parameters,output:{schema,render},execute(args,exec),presentCall})`: from the documented usage of the official `@deepseek-ai/dsh-tools` (research report A3), where `exec.agent` exposes the session context.
- One instance per harness + an in-memory snapshot cache; at most a 300 ms asynchronous refresh in `pre-step` (core `ensureContext` only reads the index, on the order of milliseconds).
- The `LLM` bridge merges `LlmRequest.system + prompt` into a single user message (auto-memory only demonstrates `createUserMessage`, with no evidence for a system-role usage); `completionTokens` is left unset for now.
- `minimumReleaseAge` in the profile will block freshly published versions (inferred from the existence of the `minimumReleaseAgeExclude` allowlist; the pnpm global config itself was not read).

## 4. Unverified list and 10-step real-machine test plan `[U]`

Prerequisite: `dsh` (0.2.1-rc.2) is already installed on this machine. Use a **separate scratch profile**; no step touches the `desktop` profile or `~/.dsh/memory`:

1. `dsh --help` to confirm the non-interactive invocation (`-p/--print` or equivalent) and `dsh --profile <p>` behavior; `dsh plugin --help` has already confirmed pnpm forwarding (this note's §2.1).
2. `dsh plugin --profile harnmem-probe add <local package dir>` to install the skeleton package; check whether `<profile>/package.json`'s dependencies and `dsh.profile.bundles` are appended as expected (if the plugin carries `dsh.bundle.patch`, reconcile activates that layer; see `.agents/skills/dsh-doc/templates/package-bundle.md:99-103`).
3. **Event-name probe**: a probe plugin calls `ctx.on` for each candidate event — `agent/created`, `agent/session-start`, `agent/disposed`, `session/event`, `turn/end`, `compaction/end` — and writes a log file; run one real session and confirm which ones 0.2.1 actually fires (focus: whether `agent/session-start` exists; the asar only contains `session-start`).
4. Empty-store injection: confirm the provider payload has no harnmem section, the section returns `""`, and there are no errors.
5. Write visibility: call `memory_write` in-session → the entry appears in the next step's injection; print the section hash across two consecutive turns and assert the bytes are identical.
6. Cache triggers: cross a day boundary (fake `now`) / after `compaction`, the text changes exactly once each.
7. Tool surface: `memory_search` hits a Chinese query; `memory_read/forget/status` return a one-line model-readable conclusion; the approval guard for `memory_forget hard`.
8. Subagents: construct a delegationDepth>0 scenario and assert 0 writes, 0 `sessionEnd` calls, and no Map residue.
9. Dispose: after `agent/disposed`, `sessionEnd` finishes within 8 s (a no-LLM profile returns `no_llm`); the plugin unload `ctx.effect` flush does not hang exit.
10. Migration: run `migrate --dry-run` against `~/.dsh/memory` and `~/.pi/agent/memory` → manually review the plan table → `apply` → `verify` → re-run `dry-run` and expect 0 new records (idempotent); `--rollback` returns to the initial counts. ZCode/Claude sources await samples.

Optional extra probe: after installation, `dsh plugin --profile harnmem-probe why harnmem-dsh` shows pnpm's real package path and peer resolution status; if the peers are not provided by the host but resolve inside the profile, re-align `exports`/`peerDependencies` with dsh-auto-memory.

## 5. Do-not list

- Do not write custom session events (R4); do not edit `cordis.yml` (it is always `[]`; only `cordis.patch.yml` changes).
- Do not use `ctx.fs` to read/write `~/.harnmem`; do not assume `$DSH_HOME` exists.
- Do not do I/O inside the section callback; do not put timestamps/counters/random ordering into the per-turn injected text.
- Do not physically delete source files or old versions during migration; do not downgrade projects that fail to resolve into user scope (they go to the `unresolved` bucket and are reported).
- Do not claim the DSH adapter is "supported" before it has been verified in a scratch profile.
