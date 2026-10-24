# dsh-harnmem

[HarnMem](https://github.com/ys118/harnmem) memory for [DSH](https://github.com/ys118/deepseek-harness)
(DeepSeek Harness): a byte-stable hot-memory index injected into the system prompt, five
`harnmem_*` tools for on-demand recall and writes, and session-end extraction that turns a
finished conversation into durable memories.

The plugin is a thin adapter. Storage, retrieval, deduplication and lifecycle live in
`@harnmem/core`; this package only maps DSH host hooks onto the core facade
(`docs/design/08-dsh-adapter.md` is the implementation contract).

## What it does

- **Injection** — one prompt section (`harnmem:hot-index`, order `4050`) renders the
  in-memory hot index. Text is identical across turns (provider prefix cache stays warm);
  it is rebuilt only at session start, compaction, after a `memory_write` in the same
  session, on a local-day rollover, and after manual consolidation. An empty store
  injects `""` (zero tokens). On the first prompt of a fresh process the snapshot may not
  be ready yet, so the section falls back to a synchronous disk render of the persisted
  index; both paths share one layout function and are byte-identical.
- **Tools** — `harnmem_write`, `harnmem_search`, `harnmem_read`, `harnmem_forget`,
  `harnmem_status`. They are thin wrappers; no retrieval logic lives here. The prefix is
  configurable (`toolPrefix`): the bare `memory_*` names belong to `dsh-auto-memory`, and
  DSH keeps the first registration, so prefixed names are the only ones that can never be
  shadowed.
- **Session end** — user/assistant messages and tool names are accumulated from
  `session/event` (≤200 entries, ≤2 KB each; eviction drops the oldest non-user entry
  first, so early user prompts survive tool noise) and handed to `sessionEnd` when the agent
  is disposed. The dispose handlers return their promise, de-duplicate concurrent disposal,
  and bound the extraction race at `llmTimeoutMs` (60 s). Extraction runs `autoExtract` gates
  in core; without a host LLM the result is `no_llm` and nothing is written.
- **Quit path / resume catch-up** — the host tears the provider adapters down before
  `plugin_unload`, so no LLM call can run at quit. The session journal is durable: on
  the next open of the same session the digest is hydrated from it and, once
  `minUserMessages` (default 3) prompts are covered, `sessionEnd` runs with
  `reason:"resume_catchup"` while the LLM is alive. The `extract` audit events are the
  cross-process watermark, so a completed extraction is never repeated; newer turns
  are extracted on a later open.
- **Child agents** — subagents (`delegationDepth > 0`, `parentSession`, or
  `subagentDepth > 0`) get a read-only engine: they can search/read but never auto-write
  or extract. Only root agents persist memories.

## Install

DSH profiles install bundles through the CLI:

```bash
dsh plugin --profile desktop add /path/to/packages/dsh-harnmem
```

The package declares `dsh.manifestVersion: 1` and `dsh.bundle.patch: ./cordis.patch.yml`, so
the reconcile step activates a layer; `cordis.patch.yml` inserts one row (`id: dsh-harnmem`,
`name: dsh-harnmem`). Remove with:

```bash
dsh plugin --profile desktop remove dsh-harnmem
```

Config can be set in that patch row, or overridden per profile in
`~/.dsh/profiles/<profile>/cordis.patch.yml` by targeting the same id.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `home` | `$HARNMEM_HOME` or `~/.harnmem` | Memory store root (plain files, shared by all harness adapters) |
| `injectMaxTokens` | `1200` | Hot-index token budget |
| `hotEntries` | `24` | Max entries in the hot index |
| `autoExtract` | `true` | Run session-end extraction when a host LLM is available |
| `minUserMessages` | `3` | User prompts required before extraction (also gates the resume catch-up) |
| `projectScope` | `true` | Attribute project-scope memories to the session cwd project |
| `llmTimeoutMs` | `60000` | Bound for extraction (never blocks shutdown; measured 10.8–14.1 s headless, 33.3 s desktop catch-up) |
| `consolidateEveryWrites` | `25` | Mechanical consolidation interval (0 disables) |
| `toolPrefix` | `harnmem_` | Prefix for the five model-facing tools (env `HARNMEM_TOOL_PREFIX`) |
| `log` | `on` | File log mode: `off` / `errors` / `on` (env `HARNMEM_LOG`); writes `~/.harnmem/logs/dsh.jsonl` |

Example profile patch:

```yaml
- id: dsh-harnmem
  config:
    home: /home/me/.harnmem
    injectMaxTokens: 1500
    autoExtract: true
```

## Memory store

Plain files under `~/.harnmem` (or `$HARNMEM_HOME`): one Markdown file per memory with
YAML-subset frontmatter, a rebuildable index, an audit log, and a migration ledger. No
server, no database, no network calls from the core — the only network path is the host
LLM bridge used for session-end extraction.

## Security

- No credentials, tokens or cookies should be stored; core redacts obvious secrets before
  injection and keeps sensitive records out of the default search path.
- `memory_forget` moves records to a 30-day trash by default; `hard: true` deletes
  physically and is audited.
- The plugin never writes to DSH's own config, session logs or profile directory.

## Compatibility

| Component | Version | Evidence |
|---|---|---|
| DSH runtime | `0.2.1-rc.2` | asar probe for `agent/created`, `agent/pre-step`, `session/event`, `agent/disposed`, `systemPrompt.section`, `tools.register`, `defineTool` |
| DSH checkout used for types | `0.1.3-alpha.1` | `packages/dsh-harnmem/src/dsh-types.d.ts` ambient declarations |
| Node.js | `>=22.15` | `node:zlib` zstd for migration, `node:test` for tests |

The running host resolves `@deepseek-ai/*` from its own `app.asar`; the rc builds published on
npm (`0.1.5-rc.3`) are older than the `0.2.1-rc.2` runtime. The adapter therefore compiles
against the ambient declarations in `src/dsh-types.d.ts` and declares host packages as
*optional* peers: without a host module it degrades to injection-only / `no_llm` instead of
crashing. pnpm's peer auto-install does pull the published rc builds into the workspace
`node_modules` for local development, but they are not the runtime versions and are never
bundled.

## Observability

Every lifecycle decision is logged with the `[dsh-harnmem]` prefix and, when a file log is
enabled (the trial default), mirrored as JSON lines to `~/.harnmem/logs/dsh.jsonl`:
`plugin.apply`, `plugin.ready`, `session.created`, `session.started`, `snapshot.rebuilt`
(reason, sha, bytes), `snapshot.failed`, `session.compacted`, `session.end`
(status/added/superseded/skipped/skipReason/digest size/user messages/turns/elapsed),
`session.endTimeout`, `session.disposed`, `tools.registered`, `digest.hydrated`,
`extract.catchup`, `extract.catchupFailed`, and the extraction LLM bridge
(`llm.call`, `llm.response`, `llm.callFailed`, `llm.reasoningUnsupported`). Core also appends
`kind:"extract"` events to `~/.harnmem/state/audit.jsonl` for every extraction outcome.
Tests read these entries.

## Known limitations

- **Extraction is verified end-to-end in the real runtime (2026-10-23).** A disposable ACP
  profile booting the installed DSH 0.2.1-rc.2 held 3 real user turns; on dispose the
  adapter logged `session.end status=done added=3`, `audit.jsonl` recorded one `extract`
  event and three `write` events, three memory files were written, and the next session
  injected them (719 B / 170 tokens). The desktop GUI repeat is tracked in N1. This path
  used to be silent because `memory_write` was shadowed by `dsh-auto-memory`, the digest
  evicted early prompts, the dispose handler was fire-and-forget, the 8 s budget raced a
  ~11 s extraction, and the LLM bridge imported a host-internal module that a `link:` install
  cannot resolve; all five are fixed (see `docs/research/dsh-write-silence-2026-10-23.md`).
- **Quit-time extraction is deferred, not lost (2026-10-24).** At `plugin_unload` the
  provider adapters are already gone (`code:"NO_ADAPTER"` in ms), so the write happens
  on the next open of the same session instead (the desktop app resumes the last
  session on launch). Verified in the real headless runtime: `digest.hydrated` 6
  entries / 3 users → `extract.catchup added:1` → one memory file; the dispose that
  followed logged `already_extracted`. A session that is never reopened is not
  extracted (the journal is kept).
- **A `link:`/path install is still not the product install.** The plugin resolves its host
  packages structurally (`ctx.get`, structural types) and declares them as optional peers;
  installing into a production profile is a user decision, and a path install also needs
  `@harnmem/core` resolvable (publish core first, N7).
- `agent/session-start` is unverified in DSH 0.2.1: it is registered defensively and only
  upgrades the snapshot on resume.
- Token accounting for extraction calls is not exposed by the streaming API, so
  `completionTokens` is omitted. Reasoning models can spend most of the token budget on
  hidden reasoning; the bridge requests a 4,096-token floor and falls back through
  `none`/`minimal`/`low`/default reasoning effort.
- `context.systemPrompt.context()` is intentionally not used: it materializes a durable
  user-role snapshot that would break prefix stability. The first prompt of a fresh process
  is covered by the synchronous cold-start fallback (`@harnmem/core`'s
  `renderHotContextSync`, byte-identical to the engine block).

## Development

```bash
pnpm install                     # at the repo root, links @harnmem/core
pnpm --filter dsh-harnmem build
pnpm --filter dsh-harnmem typecheck
node --test packages/dsh-harnmem/test/*.test.mjs
npm pack --dry-run               # inside packages/dsh-harnmem
```

## License

MIT
