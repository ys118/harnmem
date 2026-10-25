# 08 · DSH Adapter (second harness, detailed design)

> Upstream research: `docs/research/dsh-plugin-and-migration.md` (version baseline: local DSH **0.2.1-rc.2** / Node 24.21.0 / pnpm 11.28.5; source checkout `~/projects/deepseek-harness` = **0.1.3-alpha.1**; the two versions differ, see §8).
> Dependency contract: `docs/design/07-adapter-contract.md` §1 (the `HarnMem` facade) + `packages/core/src/types.ts` (`HARNMEM_API_VERSION=1`, frozen). This document deliberately does **not** use sketch method names from the early report such as `eng.sessionStart()/hotIndexBlock()`; everything maps onto the frozen API.
> Status: design complete, **runtime e2e not performed** (on this machine `@deepseek-ai/*` entries in the profile are dead junctions; see §8 R2). Every item marked `[verified]` has file:line evidence in `docs/research/dsh-impl-notes.md`; `[inferred]` is derived from the API shape; `[unverified]` requires a real-install check.

## 1. Package shape and installation

One npm package = one cordis plugin + one profile layer (`cordis.patch.yml`):

```
packages/dsh-harnmem/
├── package.json          # name=dsh-harnmem, dsh.manifestVersion/dsh.bundle.patch + peerDependencies
├── cordis.patch.yml      # bundle layer: one insert row, id=dsh-harnmem name=dsh-harnmem
├── tsconfig.json
└── src/index.ts          # host adaptation only; all memory logic lives in @harnmem/core
```

`package.json` (peerDependencies from the same family as dsh-auto-memory 0.9.0; **no `dependencies` for host packages**):

```jsonc
{
  "name": "dsh-harnmem",
  "version": "0.2.0",
  "type": "module",
  "main": "lib/index.js",
  "engines": { "node": "^22.19.0 || >=24.0.0" },   // same as the host; zstd needs >=22.15
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.2 <5.0.0",
    "@deepseek-ai/dsh-agent": ">=0.1.5-rc.2 <0.3.0",
    "@deepseek-ai/dsh-atomic-write": ">=0.1.5-rc.2 <0.3.0",
    "@deepseek-ai/dsh-home-paths": ">=0.1.5-rc.2 <0.3.0",
    "@deepseek-ai/dsh-llm": ">=0.1.5-rc.2 <0.3.0",
    "@deepseek-ai/dsh-session": ">=0.1.5-rc.2 <0.3.0",
    "@deepseek-ai/dsh-system-prompt": ">=0.1.5-rc.2 <0.3.0",
    "@deepseek-ai/dsh-tools": ">=0.1.5-rc.2 <0.3.0",
    "@deepseek-ai/schemastery": "^3.18.2"
  },
  "dependencies": { "@harnmem/core": "0.2.0" },
  "dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`[verified]` `dsh-auto-memory/package.json` has exactly this shape; the profile's `pnpm-workspace.yaml` sets `nodeLinker: hoisted` + `autoInstallPeers: false` → **peers are not installed into the profile**; the host process provides them at load time.

> In dsh-auto-memory, `@deepseek-ai/schemastery` is a normal dependency (the profile's `@deepseek-ai/schemastery` and `cosmokit` are real directories). Our package likewise lists it under dependency; all other host packages stay peers.

The bundle layer `cordis.patch.yml` (`[verified]` copied verbatim from dsh-auto-memory's 3-line format; the comment notes: the insert row's `name` must be the npm package name, and omitting config uses the plugin schema defaults):

```yaml
- insert:
    - id: dsh-harnmem
      name: dsh-harnmem
```

Install/enable (`[verified]` via `dsh plugin --help`: the subcommand **forwards its arguments unchanged to pnpm in the profile directory**, and `--profile` initializes the profile on first use):

```bash
# 1) local development (pnpm add <dir> creates a link, no registry change)
dsh plugin --profile desktop add <repo>/packages/dsh-harnmem
# 2) after publishing (mind the profile pnpm's minimumReleaseAge: a fresh version may be rejected; add an exclude or wait for the window)
dsh plugin --profile desktop add dsh-harnmem
# 3) the profile's package.json must show the dependency + dsh.profile.bundles must append "dsh-harnmem"
# 4) user config override: the profile's cordis.patch.yml replaces the config table by id (schemastery merge, not a deep merge)
```

```yaml
# ~/.dsh/profiles/desktop/cordis.patch.yml
- id: dsh-harnmem
  name: dsh-harnmem
  config:
    injectMaxTokens: 1200
    autoExtract: true
```

Profile composition order (`[verified]` from a `cordis.yml` comment): `dsh.profile.bundles` bundle layers in order → `cordis.patch.yml` → `--patch` overlay. `cordis.yml` itself is always `[]`; do not edit it by hand.

## 2. Plugin exports and config schema

`[verified]` `name/inject/Config/apply` **must be named exports**; `export default` drops `inject` (postmortem `docs/postmortem/0001-acp-default-export-drops-inject.md`). Config is declared with schemastery; defaults live only in the schema:

```ts
import z from "@deepseek-ai/schemastery";
export const name = "dsh-harnmem";
export const inject = ["tools", "systemPrompt"];          // llm is an optional service: ctx.get("llm")
export const Config = z.object({
  home: z.string().default(""),                            // empty = $HARNMEM_HOME > ~/.harnmem
  injectMaxTokens: z.number().default(1200),               // → HarnMemConfig.budget.injectTokens
  hotEntries: z.number().default(24),
  autoExtract: z.boolean().default(true),                  // → write.autoExtract
  projectScope: z.boolean().default(true),
  llmTimeoutMs: z.number().default(60000),                // extraction budget (hard cap; 10.8–14.1 s headless, 33.3 s desktop catch-up)
  consolidateEveryWrites: z.number().default(25),
});
export function apply(ctx: Context, config: z.infer<typeof Config>): void { ... }
```

`apply` resolves `HarnMemConfig` (priority exactly as in 07 §7): `home` = `HARNMEM_HOME` > `config.home` > `<homedir>/.harnmem`; `harness: "dsh"`; `sessionId/cwd` come from the agent (§4); `llm` is injected by `makeLlmFn`; `readOnly` = with no `llm` and `autoExtract` true, tool writes still work but automatic extraction does not happen.

**Do not use `ctx.fs` to access `~/.harnmem`** (`[verified]` the default fs sandbox write roots do not include home; auto-memory explicitly uses `node:fs`), and **do not** reuse `$DSH_HOME` semantics — harnmem's home is the single cross-harness root.

## 3. Hook mapping (host events → harnmem calls)

| Host hook | Evidence | harnmem action | Notes |
|---|---|---|---|
| `agent/created` `[{agent}]` | `[verified]` 0.2.1 asar; checkout `runtime-types.ts:204` | `HarnMem.open(cfg)` (async, one instance per session), then `ensureContext("session_start")` | Primary startup point (see R3: in the 0.2.1 asar, `agent/session-start` appears only as the substring `session-start`) |
| `agent/session-start` `[{agent,source}]` | `[unverified]` 0.2.1; checkout `runtime-types.ts:262` | Idempotent boot; if `source` is resume → `ensureContext("resume")` | Use it if present: force a snapshot rebuild after resume |
| `agent/pre-step` `[{agent,messages,turn,step,signal},next]` | `[verified]` asar | When dirty, `await ensureContext(...)` (300ms budget, keep the old snapshot on failure) then `return next()` | The only place allowed to refresh asynchronously before injection; **the section callback itself must stay synchronous** |
| `session/event` `(session,event)` | `[verified]` asar; `session.md:1111-1127` | ① Collect digest by `event.type` (`user/message`, `assistant/message`, `tool/call`) ② `compaction/end` → dirty + rebuild ③ `turn/end` → lightweight cursor | Never write custom session events (R4) |
| `compaction/*` | `[verified]` asar has `compaction/summary`; `compaction.md:13-19` | Event-driven: `compaction/end` → `ensureContext("compaction")` | **No need** to call the `ctx.compaction` service (correction to the 07 §5 sketch; the seam is an optional capability, see `compaction.md:130`) |
| `turn/end` | `[verified]` asar | Digest turn counter; at threshold, background `consolidate({mechanicalOnly:true})` | No LLM call, no blocking |
| `agent/disposed` `[{agent}]` | `[verified]` asar; checkout `runtime-types.ts:213` | `sessionEnd({sessionId,cwd,messages:digest,reason})` (bounded race, 60 s default) → `close()`; handler returns the promise | Skip child agents (§5); on failure only `ctx.logger.warn` |
| `session/disposed` `(session)` | `[verified]` asar | Clean up the Map (leak prevention; `sessionEnd` no longer waits at this point) | Cleanup only; return the dispose promise |
| Plugin unload | `[verified]` auto-memory `lib/index.js:1875` | `ctx.effect(function*(){ yield async () => Promise.allSettled([...engines].map(e=>e.close())) })` | Wait for in-flight extraction to land |

`[runtime-verified 2026-10-24]` **The quit path is deferred rather than broken.**
At `plugin_unload` the host has already disposed the provider adapters, so a
dispose-time `sessionEnd` LLM call fails in milliseconds (`code:"NO_ADAPTER"`).
The adapter therefore treats the durable journal as the queue: on `agent/created`
it hydrates the digest from `readSessionJournal()` and, once
`userMessages >= minUserMessages` and the engine is writable, schedules
`sessionEnd({reason:"resume_catchup"})` in the background while the LLM is alive;
`dispose()` joins that promise before closing. Core's `extract` audit events are
the cross-process `messages` watermark, so a completed extraction is never
repeated and only newer turns re-trigger (§11).

`ctx.systemPrompt.section({name,order,text})` `[verified]`: `text` may be `(c)=>string`, re-evaluated every step, executed synchronously; `order` ascending (autoload's memory section uses 4000). `ctx.tools.register(def)` `[verified]`; every event registration uses `ctx.on(event, handler)`.

## 4. Injection design (byte stability is a hard constraint)

The section returns only the **in-memory** `ContextBlock.text`; no I/O, no timestamps or counters:

```ts
interface Session {
  eng: HarnMem;
  snap: ContextBlock;          // current injection text (byte-stable)
  digest: TranscriptMessage[]; // used for extraction at dispose
  dirty: boolean;              // needs rebuild
  dayKey: string;              // local date; crossing midnight triggers day_rollover
  pending: Promise<void> | null;
}

ctx.systemPrompt.section({
  name: "harnmem:hot-index",
  order: 4050,                                  // after the AGENTS.md/CLAUDE.md chain and dsh-auto-memory's 4000 section
  text: (c) => {
    const s = c.agent && sessions.get(c.agent.session.id);
    return s ? s.snap.text : "";               // empty store → "" (zero tokens)
  },
});
```

Rebuild triggers (consistent with 03 §5.2 / 07 §4.3; the adapter implements the dirty protocol, determinism is guaranteed by core's `ensureContext`):

1. Session start / resume; 2. `compaction/end`; 3. `memory_write` within this session (before the tool returns, `await eng.ensureContext("memory_write")` so the next step sees it); 4. day rollover (`pre-step` compares `dayKey`, local timezone); 5. after a manual `memory_consolidate`.
In every other case the **bytes stay unchanged**; `ContextBlock.snapshotAt` goes to the audit log only and is **never concatenated into the injection text** (the snapshot tail caveat line is generated by core and fixed for the session).
Before returning `text`, template braces are neutralized (core already does this; the adapter must not post-process, or byte stability breaks); `fail closed`: on any exception return the previous snapshot and never throw.

**Per-turn recall does not use `ctx.systemPrompt.context()`**: that is a durable user-role snapshot that gets materialized across steps, changes the prefix once written, and is replayed automatically after compaction — incompatible with the v1 design of "tools retrieve on demand". Recall always goes through `memory_search` tool results (tool results do not pollute the system prompt).

### 4.1 Cold-start fallback (verified at runtime)

The host assembles the prompt **before** `agent/pre-step` runs, while `agent/created` opens the engine asynchronously. On a fresh process the first assembly can therefore happen while the in-memory snapshot is still empty, which would silently skip injection for the first turn (observed in a local headless DSH run: review request had `injected=false` despite a non-empty store).

Fix: when the snapshot is empty, the section callback falls back to `renderHotContextSync({home, cwd})` from `@harnmem/core`, which renders the same block synchronously from the persisted per-shard index JSON (`node:fs` reads cached by mtime/size) and the digest pages. The layout function is shared with `HarnMem.ensureContext()`, and a core test asserts byte equality between the two paths. Once attach finishes, the engine snapshot takes precedence again, so steady-state bytes and the dirty protocol are unchanged.

The runtime check exercised the real desktop runtime (disposable profile, local mock OpenAI-compatible endpoint): session 1 called `memory_write` and persisted `<memory-id>`; a new process/session then saw `systemChars 2994, injected=true` and the audit log recorded reason `session_start` with the same id. The adapter test suite covers the race shape (section evaluated before attach settles).


## 5. Tool mapping

No retrieval logic lives in the package; all 5 tools are thin wrappers (parameter names identical to 07 §3; names carry a configurable prefix — `harnmem_` by default, `harnmem_write/search/read/forget/status`, because `dsh-auto-memory` registers the bare `memory_*` names and DSH keeps the first registrant):

| Tool | Params → core | Implementation notes |
|---|---|---|
| `memory_write` | `type/category/scope/title/description/content/tags/entities/importance/pinned/links/supersedes` → `eng.write(WriteInput)` | scope `auto` → resolved against the cwd project; `WriteResult.action` is rendered as one line `stored mem_x (NEW)` / `already exists mem_x (SKIP)` / `superseded mem_a → mem_b`; rebuild the snapshot after writing |
| `memory_search` | `query/limit/scope/include_archived/as_of/entity/debug` → `eng.search` | Compress results into the 03 §5.4 JSON (including `hint`); on `abstained:true` return "no memory is confident enough" |
| `memory_read` | `id/as_of/include_history` → `eng.read` | frontmatter summary + body + backlinks + `(historical)` |
| `memory_forget` | `id/hard` → `eng.forget` | trash for 30 days by default; `hard:true` physically deletes (audit keeps only id/time/reason); recommend a `tools/pre-execute` guard requiring approval for hard deletes |
| `memory_status` | → `eng.stats()` | Plain-language summary: counts/capacity/pinned/health/last consolidation |

`defineTool` skeleton (`[verified]` shape from the official `@deepseek-ai/dsh-tools`, used for parameter inference/validation; `exec.agent` is available inside `execute(args, exec)`):

```ts
import { defineTool } from "@deepseek-ai/dsh-tools";
ctx.tools.register(defineTool({
  name: "memory_search",
  description: "Search persistent memory (user + current project). Returns id/title/description/snippet.",
  parameters: {
    query: { type: "string", required: true, description: "natural-language query; Chinese is matched by bigram" },
    limit: { type: "number" },
    scope: { type: "string", enum: ["user", "project"] },
    include_archived: { type: "boolean" },
    as_of: { type: "string" },
    entity: { type: "string" },
  },
  output: { schema: { type: "object", additionalProperties: false,
    properties: { results: { type: "array", required: true, items: { type: "object",
      additionalProperties: false, properties: {
        id: { type: "string", required: true }, title: { type: "string", required: true },
        description: { type: "string" }, snippet: { type: "string" } } } },
      hint: { type: "string" } } },
    render: (_a, v) => [{ type: "text", text: JSON.stringify(v) }] },
  async execute(args, exec) {
    const eng = requireEngine(exec.agent, sessions);       // child agents get a read-only instance (§6)
    const r = await eng.search({ query: args.query, limit: args.limit ?? 8, scope: args.scope ?? "all" });
    return renderSearch(r);
  },
  presentCall: (args) => ({ card: "generic", title: `memory_search: ${args.query}`, kind: "other", rawInput: args }),
}));
```

Tool registration failure → degrade to "injection only" (07 §2); wrap each `register` in try/catch and `ctx.logger.warn`.

## 6. Session lifecycle, cwd/sessionId, and the LLM bridge

```ts
const sessions = new Map<string, Session>();
const hostOf = (agent: Agent) => ({
  sessionId: agent.session.id,
  cwd: agent.session.header.cwd,                       // [verified] the only official way to get cwd
  depth: Math.max(agent.session.header.delegationDepth ?? 0, agent.options.subagentDepth ?? 0),
});

async function boot(agent: Agent, reason: ContextReason) {
  if (sessions.has(agent.session.id)) return;
  const h = hostOf(agent);
  const readOnly = h.depth > 0;                        // child agents are read-only: no extraction, no automatic writes
  const eng = await HarnMem.open({ home, harness: "dsh", sessionId: h.sessionId, cwd: h.cwd,
                                  llm: readOnly ? null : makeLlmFn(ctx, agent),
                                  readOnly: readOnly || undefined });
  const snap = await eng.ensureContext(reason);
  sessions.set(agent.session.id, { eng, snap, digest: [], dirty: false, dayKey: localDay(), pending: null });
}
ctx.on("agent/created", ({ agent }) => { void boot(agent, "session_start").catch(warn); });
// agent/session-start (if 0.2.x really has it): on resume, await eng.ensureContext("resume") to overwrite the snapshot

ctx.on("session/event", (session, event) => {
  const s = sessions.get(session.id); if (!s) return;
  if (event.type === "user/message" && event.data.source?.kind === "user") pushDigest(s, "user", textOf(event.data));
  else if (event.type === "assistant/message") pushDigest(s, "assistant", textOf(event.data));
  else if (event.type === "compaction/end") { s.dirty = true; void refresh(s, "compaction"); }
});

ctx.on("agent/pre-step", async ({ agent }, next) => {
  const s = sessions.get(agent.session.id);
  if (s && (s.dirty || localDay() !== s.dayKey)) await refresh(s, s.dirty ? "memory_write" : "day_rollover");
  return next();
});

ctx.on("agent/disposed", ({ agent }) => {
  const s = sessions.get(agent.session.id); if (!s) return;
  sessions.delete(agent.session.id);
  if (hostOf(agent).depth > 0) { void s.eng.close(); return; }   // child agents do not extract
  const budget = Math.max(1000, config.llmTimeoutMs);
  void Promise.race([
    s.eng.sessionEnd({ sessionId: agent.session.id, cwd: hostOf(agent).cwd, messages: s.digest,
                       reason: "dispose" }).then((r) => auditExtract(agent, r)),
    new Promise((_, rej) => setTimeout(() => rej(new Error("sessionEnd timeout")), budget)),
  ]).catch((e) => ctx.logger.warn(`[dsh-harnmem] sessionEnd: ${String(e)}`))
    .finally(() => void s.eng.close());
});
```

Key points: everything outside the fast path of `ensureContext`/`sessionEnd` (audit, stats) is fire-and-forget; `agent/disposed` is the reliable landing point (`[verified]` auto-memory's LLM consolidation is attached there too, `lib/index.js:1797`). `sessionEnd`'s digest is accumulated incrementally by `session/event` (≤200 entries, ≤2KB per entry, `tool/call` records name only) — it does not call `session.snapshotEvents()` for a full replay.

LLM bridge (`LlmFn` is defined in `types.ts:390-406`; no host model → `null`, and core degrades to `{status:"no_llm"}`):

```ts
function makeLlmFn(ctx: Context, agent: Agent): LlmFn | null {
  const llm = ctx.get("llm") as { stream(req: unknown): AsyncIterable<unknown> } | undefined;
  const provider = agent.options.provider, model = agent.options.model;
  if (!llm || !provider || !model) return null;
  return async (req) => {
    const assembler = new BlockAssembler();
    const messages = [createUserMessage({ content: [{ type: "text", text: `${req.system}\n\n${req.prompt}` }],
                                          source: { kind: "dsh-harnmem" } })];
    for await (const chunk of llm.stream({ provider, model, messages,
        maxTokens: req.maxTokens ?? 2048, sessionId: agent.session.id, signal: req.signal })) assembler.push(chunk);
    if (assembler.finish.kind === "error") throw new Error("harnmem llm call failed");
    if (assembler.finish.kind === "aborted") throw req.signal?.reason ?? new Error("aborted");
    const text = assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (!text) throw new Error("empty llm response");
    return { text };                                  // completionTokens not available for now → omit
  };
}
```

`[runtime-verified 2026-10-23]` the shipped bridge does **not** import `@deepseek-ai/dsh-llm` (a `link:`-installed plugin cannot resolve a host-internal bare specifier; the swallowed failure produced `status:"done", added:0`). It reproduces the two wire shapes locally: a frozen user message `{id, role:"user", content:[{type:"text",text}], source:{kind:"dsh-harnmem"}}` and the chunk stream (`text-delta` appends text, `reasoning-delta` counts hidden reasoning, `finish` carries `reason.kind` ∈ `stop`/`error`/`aborted`). `reasoningEffort` is validated against the model's advertised efforts: unsupported values fail the attempt with `code:"UNSUPPORTED_REASONING_EFFORT"`, so the bridge tries `none` → `minimal` → `low` → default and logs `llm.reasoningUnsupported`. `deepseek-v4-flash` supports only `low`+; reasoning still consumed 5,926 chars for a 2,100-char JSON answer, so the extraction call uses a 4,096-token floor and a 60 s budget (§11).

`[runtime-verified 2026-10-24]` **Quit-time extraction runs on the next open, not
at quit.** The digest is seeded at attach from the journal reader
(`HarnMem.readSessionJournal`); a session with at least `minUserMessages` (3)
user prompts schedules `sessionEnd(reason:"resume_catchup")` fire-and-forget while
the host LLM service is alive. The catch-up is idempotent through the core
watermark: the audit `messages` count of the last `done` extraction for the
session is compared with the current digest length (`already_extracted` otherwise),
and only strictly newer turns re-trigger. A headless real-runtime run hydrated
6 entries / 3 users and logged `extract.catchup status:done added:1`; the dispose
that followed logged `session.end status:skipped skipReason:already_extracted`.
When the process unloads with a still-pending journal, the next open catches up.

## 7. Migration importer (`harnmem import`, idempotent/rollbackable)

> **Implementation note (v0.1):** the shipped CLI implements this design as `harnmem import dsh|pi|zcode|json` (dry-run by default; `--apply`, `--path-map`, `--project`, `--verify`, `--rollback`) in `packages/cli`; Claude Code import is designed here but not shipped yet. Where this design section and `packages/cli/README.md` disagree, the CLI README and `--help` output are authoritative. The design below is kept for the phase semantics and the migration gates.
>
> **Update (2026-10-25):** migration onboarding is now implemented per
> [`10-migration-onboarding.md`](10-migration-onboarding.md) — `harnmem import claude`
> (Claude Code project + legacy memory files, cwd recovered from session JSONL), `import md`,
> relaxed `import json` (JSONL/stdin/aliases) and `import auto`; the CLI README and
> `harnmem import help` are the authoritative surface.

Sources and field mapping are specified in `02-data-model.md` §5; this section covers only the **runtime gates** shared by the importer and the dsh adapter. Core constraint: **ADD-only + explicit SUPERSEDE** (`04-write-and-lifecycle.md`); migration must not physically delete or overwrite old files either.

Phases (each runnable separately; `--dry-run` stops after plan):

1. **discover** (read-only): enumerate `~/.dsh/memory/**` (`_user/`, `--<projectKey>--/`), `~/.pi/agent/memory/MEMORY.md` (+ optional `daily/`), `~/.zcode/cli/memories/projects/**`, `~/.claude/projects/**`; for each item record `{harness, origin_path, origin_scope, origin_id, raw_bytes, mtime}`; no network reads, no writes to source directories.
2. **parse → normalize**: dsh = YAML frontmatter (`parseMemory` semantics); pi = `<!-- date [hash] -->` comment blocks; zcode = frontmatter `name/description/metadata.type` + first H1 in the body; claude = frontmatter + first H1. Map to `MemoryRecord`: `title/description/type/category/tags/importance/pinned/created/updated/lastUsed/usedCount/status`; all times normalized to milliseconds; **any value derived from a missing source field is tagged `source.migratedFrom` + `extra.lossy[]` + `extra.inferred_time`** — never silently invented.
3. **resolve projects** (critical; three irreversible key schemes):
   - dsh: `--<projectKey>--` (`/ \ :`→`-`, illegal chars→`~XXXX`, ≤251) is **not reversible**; use the header of `$DSH_HOME/sessions/<same key>/session.v4.jsonl.zstd`, zstd-decompress it, and take the first record containing `cwd` (`node:zlib.zstdDecompressSync`, Node ≥22.15) to recover the real cwd → compute projectId per 02 §3.2. No session log → `--path-map`; still unresolved → `unresolved:<projectKey>` bucket + WARNING.
   - zcode: `<slug>-<sha256(lowercased normalized path)[:16]>` is one-way; recompute sha256 over candidate paths (paths already known to `projects.json` + `--path-map`) and match; a miss goes to unresolved.
   - pi: no project dimension → `user` by default; only an explicit project path/`#project` inside the entry tentatively maps to `project`, flagged in the report (**visible decision, never silent**).
   - claude: slug is irreversible → first record containing `cwd` in the session jsonl header (≤262144 B).
   - All resolved results are written to `projects.json` `paths[]` + `harnesses[]` for reuse by later harnesses; **project memories are never downgraded into user scope because resolution failed**.
4. **plan**: per item `NEW | SKIP(exact dup) | SUPERSEDE | MERGE(candidate) | CONFLICT`, with a human-readable table; exit after plan on `--dry-run`; `--strict` exits 2 when WARNINGs exist. Idempotency key `(origin_harness, origin_path, content_hash)`; a re-run hit → SKIP.
5. **backup**: `~/.harnmem/backup/import-<harness>-<utc>/` stores byte-for-byte source copies + a sha256 manifest; `--no-backup` requires explicit confirmation. Source directories are **never written** (rollback cost is zero).
6. **apply**: per item `store.write` (tmp+rename atomic) → `index/manifest.json` seq++ → append `{kind:"import",id,source}` to `state/audit.jsonl` → append import ledger `state/imports/<runId>.jsonl` (each line `{runId,ts,harness,origin_path,origin_hash,mem_id,action}`). A single failure does not abort the run.
7. **verify**: `count(source) == added + skipped + failed`; recompute `content_hash` for a 10% sample; `harnmem doctor` validates frontmatter/index/backlinks.
8. **rollback**: per the ledger, remove this run's mem_ids (hard forget with an audit entry in the shipped CLI) and roll back the index; source data untouched.

Runtime and migration share the same gates (no separate rule set): exact duplicate = identical normalized-body `sha256` → SKIP (provenance merged); near duplicate `simhash64` Hamming ≤3 or description similarity ≥0.82 with the same type/scope → the newer wins and SUPERSEDE (old record `validTo=now`, `status=superseded`, `supersededBy` points at the new id, **never deleted**); 0.60–0.82 → NEW + link or into `state/consolidate-queue.json` for a decision; pinned conflict → keep both + `conflicts/` copy + WARNING. For pi, `[[wiki]]` links that fail to resolve keep a namespaced `pi:<slug>` link (no information loss). `SCRATCHPAD.md`/`recovery/` are not imported by default; `daily/` is used as `sessions/` logs only by default (draft memories are imported only with `--include-daily`); the `MEMORY.md` index is discarded and rebuilt entirely (keeping only the id mapping).

## 8. Risks and checks required before writing code

| # | Risk | Evidence | Handling |
|---|---|---|---|
| R1 | ~~core typecheck drift~~ **resolved**: the core facade, config and consolidation report types are implemented and `pnpm -r typecheck` is green in v0.1.0 | `pnpm -r typecheck` | write the DSH adapter strictly against `types.ts` + 07 §1 rather than against internal modules |
| R2 | **no runtime e2e**: profile `@deepseek-ai/*` are dead junctions (pointing at a deleted nvm global path); `resources/runtime` only has node/pnpm/python, and the DSH packages live inside `app.asar` | `Test-Path` on the target is false; `runtime.json` | build a scratch profile with the local `dsh` (`resources/runtime/cli/bin/dsh.cmd`, 0.2.1-rc.2) and verify on a real install; peers are supplied by the host (`autoInstallPeers:false` confirmed) |
| R3 | **version drift**: checkout 0.1.3-alpha.1 ≠ running 0.2.1-rc.2. asar string probe: `agent/created`, `agent/disposed`, `agent/pre-step`, `session/event`, `compaction/summary`, `delegationDepth`, `system-prompt/assemble`, `tools.register`, `defineTool` are all FOUND; `agent/session-start` **not matched** (only `session-start`) | asar 182,794,869 B | use `agent/created` as the main startup hook; keep `agent/session-start` as an optional enhancement and confirm the event name with a 3-line probe after installation |
| R4 | writing custom session events makes resume refuse the session | auto-memory `lib/index.js:112` design comment | audit to harnmem's own `state/audit.jsonl`; never `session.append` private events |
| R5 | the success variant of `BlockAssembler.finish.kind` is unconfirmed (only `error`/`aborted` observed) | `lib/index.js:1831-1835` | treat non-empty `blocks()` as success; add logging on the first run |
| R6 | KV prefix cache: every change to the injected text causes a full miss | 03 §5.2 / 07 §4.3 | rebuild only at the 5 triggers in §4; stable sort keys (day granularity); injection text carries no timestamps |
| R7 | migration zstd decompression needs Node ≥22.15; the target machine runs Node 24.21, which satisfies it | `runtime.json` | the importer automatically degrades to `--path-map` on older Node |
| R8 | ZCode data does not exist on this machine (`~/.zcode` missing) | research report B1.3 | the importer treats "no data" as SKIPPED, not an error; real-data validation needs a sample from a user |
| R9 | the profile pnpm `minimumReleaseAge` may block a just-published version | the profile `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` already has a back door for two packages | state in the release notes: add an exclude, or install locally with `pnpm add <dir>` |

## 9. Acceptance checklist (DSH-specific, layered on 07 §8)

- [x] Empty store: the section returns `""`, the provider payload has no empty segment; tools register successfully
- [x] Write one record (`harnmem_write`) → visible in the injection on the **next step** (dirty→pre-step rebuild), and bytes stay unchanged for the rest of the session
- [x] systemPrompt bytes identical across two turns (assert by printing a hash); they change exactly once after day rollover/compaction
- [x] `harnmem_search` hits a Chinese query (bigram + synonyms work)
- [x] After `agent/disposed`, `sessionEnd` finishes within the 60 s budget and writes memories; shutdown does not hang (the race-timeout path has a test; a real extraction measured 10.8–14.1 s headless and 33.3 s for a desktop catch-up)
- [x] Child agent (delegationDepth>0) is read-only: 0 writes, 0 extractions, no Map residue after disposal
- [x] Profile without an LLM: tool writes work, `sessionEnd` returns `{status:"no_llm"}`
- [x] Resume session: the injection snapshot is rebuilt and the engine is not created twice
- [x] Quit-path extraction is deferred to the next open: the digest is hydrated from the journal, catch-up `sessionEnd(reason:"resume_catchup")` runs while the LLM is alive, and a completed extraction is not repeated (audit `messages` watermark)
- [ ] After migration, old memories are searchable via `harnmem_search`, and re-running migrate adds 0 new records (idempotent)

## 10. Landing order

1. core convergence (R1) → `pnpm --filter @harnmem/core build` passes;
2. skeleton `packages/dsh-harnmem/{package.json,cordis.patch.yml,src/index.ts}` (the code in this document compiles);
3. install the local package into a scratch profile and pass the first 3 items of §9;
4. land the importer's dsh source first (richest format, most samples), then pi, then zcode/claude once samples exist;
5. cross-check against the pi adapter: the same `harnmem_write` produces byte-identical files in both harnesses (apart from `source.harness`) — stronger than any documentation promise.

## 11. Implementation delta (2026-10-23)

Everything below landed while closing N2; the sections above describe the intended contract, this list records where the shipped code deliberately differs and why (evidence: `docs/research/dsh-write-silence-2026-10-23.md`).

1. **Tool names are prefixed** (`toolPrefix`, default `harnmem_`, env `HARNMEM_TOOL_PREFIX`). §5's bare `memory_*` names collide with `dsh-auto-memory`, which wins registration; the write path was dead because `memory_write` was one of the two collisions. Suffixes stay `write/search/read/forget/status`; hint strings in search/read results use the configured prefix.
2. **A real file logger exists** (`~/.harnmem/logs/dsh.jsonl`, JSON lines, `log: "on"|"errors"|"off"`, env `HARNMEM_LOG`). The design only used `ctx.logger`, so every gate was invisible. The sink is a bounded chained append (same shape as `pi-harnmem`), flushed in the unload effect; `log: "on"` is the trial default, `errors` the quiet production setting.
3. **Core writes `kind:"extract"` audit events** for every `sessionEnd` outcome (status/reason/added/superseded/skipped/messages/userMessages), not just success — this is N13's instrumentation.
4. **Digest eviction preserves user prompts.** At `MAX_DIGEST_ENTRIES` the ring drops the oldest `role !== "user"` entry first (oldest prompt only when every entry is a prompt), so `minUserMessages: 3` can still be satisfied by a session whose first prompts fell out of the 200-event window. Core still appends `messages.slice(-200)` to the transcript before gating.
5. **Dispose is awaited, deduped and bounded.** `agent/disposed` / `session/disposed` handlers return their promise; a per-session `ending` promise makes concurrent disposal idempotent; the race budget is 60 s (measured extraction 10.8–14.1 s headless, 33.3 s desktop catch-up); the unload effect awaits `closeAll()` then `log.flush()`. The host does not await `session/disposed` (verified: the ACP `session/close` response arrives before extraction finishes), so the budget only delays background work; at process unload provider adapters are already gone and the call fails in ms.
6. **The extraction LLM call is a local protocol bridge** (§6): no host-internal imports, reasoning-effort fallback, 4,096-token floor. Real run: `llm.response` 2,100 chars with 5,926 reasoning chars → `session.end status=done added=3`.
7. **End-to-end verification** used a disposable ACP profile bootstrapped from the shipped `acp` template and installed with `dsh plugin add <path>`; it booted the same DSH 0.2.1-rc.2 runtime. Three user turns → `audit.jsonl` `extract added:3` + three `write` events + memory files; the next session injected the memories (719 B / 170 tokens) and extracted one more. The desktop GUI repeat is folded into N1.
8. **The digest is hydrated from the durable journal and quit-time extraction is a catch-up at the next open** (§6). The host tears the provider adapters down before `plugin_unload`, so no LLM call can run at quit (`code:"NO_ADAPTER"` in ms). On attach the adapter seeds the digest with `readSessionJournal()` and, once `userMessages >= minUserMessages`, schedules `sessionEnd(reason:"resume_catchup")` while the LLM is alive (the desktop app resumes the last session on launch); `dispose()` joins that promise. Headless real runtime: 6 entries/3 users hydrated → `extract.catchup status=done added=1`, audit `extract added:1`, memory file written.
9. **Core extraction is idempotent across processes and its failures are visible.** The `messages` count of the last `done` `extract` audit event is the watermark (`already_extracted`), LLM errors propagate to `status:"failed"`, and short digests skip as `digest_too_small`; the journal readers tolerate a leading UTF-8 BOM (PowerShell 5.1 `Set-Content -Encoding utf8` prepended one and silently dropped the first entry).
10. **Adapter config gained `minUserMessages`** (default 3), passed to core's write config, and `session.end` records `elapsedMs` (extraction duration) separately from `sessionAgeMs`.

## 12. Memory browser panel (2026-10-24)

By 2026-10-24 the store, injection, extraction and the five tools were all verified, but the only ways to observe them were the model (`harnmem_*` tools), the CLI (`harnmem status` / `search`), and `~/.harnmem/logs/dsh.jsonl`. A human could not see which shards exist, what would be injected in the current project, whether the index is stale, or whether a project shard is silently missing from injection. This section documents the read-only browser added to the DSH web GUI (the desktop app renders the same GUI): a **Memory** icon in the left sidebar opens a panel over five views.

### 12.1 Scope and non-goals

- v1 is strictly **read-only**. No write, delete, pin, forget or config action; the write path stays in the model tools and the CLI, where the audit trail exists.
- The panel reads the files under `~/.harnmem` through `MemoryInspector`, **not** the adapter's in-process engine. It has to work in a host that has no session, no LLM and no engine, and it must not race the adapter's engine (single-writer discipline for the store).
- No new config keys (the panel is always on), no new dependencies (the client requires React plus the host client packages already declared as optional peers), and no separate npm package — it ships inside `dsh-harnmem`.
- Explicit non-goals for v1: in-panel writes, server-side search, and audit/trash/migration views (see 12.9).

### 12.2 Three layers

```
@harnmem/core        packages/core/src/inspect.ts          MemoryInspector — read-only file access
        ↓ in-process method calls
dsh-harnmem host     packages/dsh-harnmem/src/panel-api.ts six GET routes under /api/harnmem/
        ↓ same-origin HTTP, JSON envelope
dsh-harnmem client   packages/dsh-harnmem/src/client/**    React panel (browser bundle)
```

- **core** — `MemoryInspector.open({ home, cacheTtlMs })` resolves `home` as option > `HARNMEM_HOME` > `~/.harnmem` and constructs a store handle only: no `Store.init()`, no `HarnMem.open()`, no disk writes, no LLM. Records come from `memories/<shard>/*.md` frontmatter (authoritative); `index/<shard>.json` is read only for size/staleness, and its `docTerms`/`postings` never leave the host. Parsed shards are cached for 250 ms by default and `projects.json` for 1000 ms.
- **host** — `panel-api.ts` opens the inspector lazily on first request with `cacheTtlMs: 0`, so a record written earlier in the same process by `harnmem_write` is visible immediately. Per request it resolves the project from the explicit `cwd` query or, when absent, the most recently active session (running session first, then turns, then `updatedAt`) — the same heuristic the client uses. Errors are mapped to the envelope instead of escaping the route.
- **client** — `face.ts` is the fetch wrapper (same-origin `/api/harnmem/<route>`, auto `cwd` from the active session, envelope parsing, `MemoryApiError`); components render explicit loading / empty / error states and the panel root has an error boundary so a component crash shows an error message instead of a white screen.

### 12.3 Slot contract

Two registrations make one panel:

| Slot | Registration | Meaning |
|---|---|---|
| `sidebar.panellist` | `id: "harnmem"`, `order: 60`, `label: () => t("panel")` ("记忆" / "Memory"), locale NS `harnmem` | the icon row in the left sidebar |
| `main` | keyed slot, `key: "harnmem"`, locale NS `harnmem`, `inject: () => ({ face })` | the panel body opened by that row |

`key === id` is a hard contract: the sidebar row opens the `main` entry whose key equals the row id, and a mismatch does not throw — the row simply opens nothing. The client plugin exports `name: "dsh-harnmem"` and `inject: ["slots", "locale", "sessions"]`; the zh and en dictionaries keep identical key sets.

### 12.4 Views

| View | Content |
|---|---|
| Overview | Store home and current project; totals (records, active, superseded, archived, pinned, bytes, tokens, shards, projects, trash, digests); injection-budget meter and hot-entry stats; health issues (over budget, duplicate candidates, orphans, last consolidation); index status (manifest, `state/seq.json`, stale flag); by-type and by-harness counts; per-shard table; registered and unregistered projects; extraction pending/failed. |
| Memories | Shard selector (all / user / each project), type and status filters, local text search over title/description/preview/tags/id, and rows with type/status/pinned badges, importance, size and relative update time. Inactive records are always included in this view (`includeInactive=1`) so archived and superseded memories remain inspectable; only active records feed injection. |
| Detail | A drill-in from a row rather than a separate tab: full frontmatter, rendered Markdown body, tags/entities/links/backlinks, the supersede chain (`history`), and the raw file plus frontmatter JSON. Links, backlinks and history rows navigate to other records. |
| Index | The verbatim `MEMORY.md` hot-index text per shard — or every shard part separated by `<!-- harnmem shard: <name> -->` — with byte count and generation time. |
| Injection preview | The block currently injected, rendered by `renderHotContextSync()` (the very function the adapter's snapshot uses), with token estimate vs budget, injected ids and the shard list. |

The top bar has four tabs (Overview, Memories, Index, Injection); Detail is a drill-in from a memory row, so the five views fit without losing the list context. In v1 the injection preview has no parameter form — it uses the adapter's configured `injectMaxTokens` / `hotEntries` defaults; the route accepts `budgetTokens` / `hotEntries` overrides for diagnostics.

### 12.5 Host routes

All routes are `GET`, registered through the host `connection` service with `requestBody: "buffered"` and the full path (including `/api`):

| Route | Query | Returns |
|---|---|---|
| `/api/harnmem/overview.get` | `cwd` (optional) | `InspectOverview` |
| `/api/harnmem/memories.list` | `shard=<all\|user\|projectId>`, `includeInactive=0\|1` | `InspectList` |
| `/api/harnmem/memory.read` | `id` (required), `history=1` (optional) | `InspectMemory` or `null` |
| `/api/harnmem/context.preview` | `cwd`, `budgetTokens`, `hotEntries` (optional) | `InspectContext` |
| `/api/harnmem/index.read` | `shard` (optional) | `InspectIndexText` |
| `/api/harnmem/projects.list` | — | `InspectProject[]` |

Common conventions: every response is a `{ok:true,data}` / `{ok:false,error}` JSON envelope with `cache-control: no-store`; non-GET methods return `405`, malformed parameters `400` (positive integers, `0|1` flags, missing `id`), and internal failures `500` with the message only (stack stays in the log as `panel.api.failed`). Routes never throw past the handler.

The plugin deliberately does **not** put `connection` in its static `inject` list: headless ACP hosts and test trees do not have that service, and a static inject would make the whole plugin wait or fail. It takes the fast path `ctx.get("connection")` and, when the service is not there yet (the web server applies asynchronously), installs the routes later through a dynamic `ctx.inject(["connection"], …)`. Installation is idempotent; dispose unregisters all six routes and closes the lazily opened inspector. The panel uses no `ctx.webServer` and claims no prefix outside `/api/harnmem/`; log events are `panel.api.ready` (route count, prefix, home), `panel.api.unavailable`, `panel.api.failed`, `panel.api.routeFailed` and `panel.api.disposeFailed`.

### 12.6 Build and packaging

- `src/client/**` compiles separately (`tsconfig.client.json`, JSX, DOM lib) and `tsdown.config.ts` bundles it into `dist/client.js` in the `window.__ModuleLoader__.load({ id: "dsh-harnmem", factory: (require) => { … } })` shape. Only React and the host client packages stay external; there are no Node builtins and no `@harnmem/core` import in the browser bundle (the client mirrors the response types by hand in `src/client/types.ts`).
- `package.json` declares `exports["./client"]` pointing at `dist/client.js` and `dsh.client = { platform: "web", inject: ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-layout", "@deepseek-ai/dsh-client-ui-sidebar"] }`. The host build stays `tsc -p tsconfig.json && tsdown -c tsdown.config.ts` (`pnpm --filter dsh-harnmem build`).
- There is no new entry point for users: the panel ships inside the `dsh-harnmem` package, so installing or upgrading the plugin is enough.

### 12.7 Read-only and security constraints

- Host routes are GET-only; the panel exposes no write surface at all. Writes remain in the model tools and the CLI, where the core audit log records them.
- The browser receives summaries and file text only. The search index's `docTerms`/`postings` never cross the API (they are large and the panel does not need them), and the injection preview is the same block the model already sees, so the panel adds no disclosure path.
- No credentials, no LLM call and no network egress: the only traffic is same-origin `/api/harnmem/*`.
- The inspector never writes: it does not register a project in `projects.json` (a read must not mark a project as used), does not call `Store.init()`, does not rebuild the index and does not emit audit events. That is what lets the panel run next to the adapter without contention.
- Rollback is uninstall-level: no config keys and no store schema changes were added; removing or downgrading the plugin removes the panel.

### 12.8 Verification (2026-10-24)

- Unit/integration: `@harnmem/core` 37/37 and `dsh-harnmem` 45/45 tests pass at the time of the panel API landing, including the new `test/panel-api.test.mjs` (route registration, envelope and error codes, 405 for non-GET, the read-only byte-stable home assertion, and both the no-`connection` and late-`connection` paths). The UI half adds its own `test/client-bundle.test.mjs` on top.
- Real store on a scratch DSH web runtime: `~/.harnmem` with 4 shards and 54 records — all six routes returned 200; `context.preview` hit shards `user,harnmem-438dc3c76d` with 24 ids and about 1,183 tokens.
- Incidental fixes the panel needed: `resolveProjectId` now prefers the recorded project id when several ids share one path in `projects.json` (otherwise the project shard was silently dropped from injection), and `loadProjects()` no longer shares `EMPTY_PROJECTS` across homes (cross-home pollution).

### 12.9 Follow-ups (not implemented)

- In-panel writes (archive, pin, edit, forget) for phase 2. They need a single-writer path — route through the adapter's engine or take an explicit lock — and must reuse core's audit events rather than writing files directly.
- Server-side search/filtering once a store grows past a few thousand records; today the client filters the loaded list locally.
- An audit/diagnostics view covering `audit.jsonl` `extract` events, `trash/`, the migration ledger and `state/seq.json` — useful to explain "why is this memory not injected".
- Optional UI controls for the injection preview: the route already accepts `budgetTokens`/`hotEntries`, but the v1 UI always uses the configured defaults.
