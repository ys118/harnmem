# dsh-harnmem

[HarnMem](https://github.com/ys118/harnmem) memory for [DSH](https://github.com/ys118/deepseek-harness)
(DeepSeek Harness): a byte-stable hot-memory index injected into the system prompt, five
`memory_*` tools for on-demand recall and writes, and session-end extraction that turns a
finished conversation into durable memories.

The plugin is a thin adapter. Storage, retrieval, deduplication and lifecycle live in
`@harnmem/core`; this package only maps DSH host hooks onto the core facade
(`docs/design/08-dsh-adapter.md` is the implementation contract).

## What it does

- **Injection** — one prompt section (`harnmem:hot-index`, order `4000`) renders the
  in-memory hot index. Text is identical across turns (provider prefix cache stays warm);
  it is rebuilt only at session start, compaction, after a `memory_write` in the same
  session, on a local-day rollover, and after manual consolidation. An empty store
  injects `""` (zero tokens). On the first prompt of a fresh process the snapshot may not
  be ready yet, so the section falls back to a synchronous disk render of the persisted
  index; both paths share one layout function and are byte-identical.
- **Tools** — `memory_write`, `memory_search`, `memory_read`, `memory_forget`,
  `memory_status`. They are thin wrappers; no retrieval logic lives here.
- **Session end** — user/assistant messages and tool names are accumulated from
  `session/event` (≤200 entries, ≤2 KB each) and handed to `sessionEnd` when the agent is
  disposed. Extraction runs `autoExtract` gates in core; without a host LLM the result is
  `no_llm` and nothing is written.
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
| `projectScope` | `true` | Attribute project-scope memories to the session cwd project |
| `llmTimeoutMs` | `8000` | Bound for `sessionEnd` at dispose (never blocks shutdown) |
| `consolidateEveryWrites` | `25` | Mechanical consolidation interval (0 disables) |

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

Every lifecycle decision is logged with the `[dsh-harnmem]` prefix: `session.created`,
`session.started`, `snapshot.rebuilt` (reason, sha, bytes), `snapshot.failed`,
`session.compacted`, `session.end` (status/added/superseded/skipped), `session.endTimeout`,
`tools.registered`. Tests read these entries.

## Known limitations

- **Verified against the runtime, not published.** The plugin was installed into a
  disposable profile with `dsh plugin --profile probe add <path>` and exercised against a
  local OpenAI-compatible mock endpoint (no external service, no real API key): a scripted
  `memory_write` landed on disk, and a new process/session received the memory through
  injection (`injected=true`, audit `reason=session_start`). Installing into a production
  profile is a user decision; a path install also needs `@harnmem/core` resolvable, so
  publish the core package (or use a tarball/pnpm link) before adding this one from a path.
- `agent/session-start` is unverified in DSH 0.2.1: it is registered defensively and only
  upgrades the snapshot on resume.
- Token accounting for extraction calls is not exposed by the streaming API, so
  `completionTokens` is omitted.
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
