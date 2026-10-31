# hermes-harnmem

Cross-harness long-term memory for [Hermes Agent](https://hermes-agent.nousresearch.com)
(Nous Research), backed by the plain-file [HarnMem](../../README.md) store.

The plugin is a Hermes **memory provider**: it injects a small, byte-stable
memory snapshot into each turn, exposes the five HarnMem tools, and runs a
bounded extraction pass when a session ends. The engine is `@harnmem/core`
(TypeScript), executed through a short-lived Node.js child process; the plugin
itself is Python because that is what Hermes loads.

The store is `~/.harnmem/` by default, so a memory written in Hermes is
available in pi, DSH, Claude Code, Codex, opencode and the `harnmem` CLI — and
memories written there show up in Hermes sessions.

## Requirements

- **Hermes Agent** v0.22.5 or newer (the stable channel; the memory-provider API
  is not versioned upstream, so pin and test against a known release).
- **Node.js 22.15+** on `PATH` (the plugin vendors the engine but needs the Node
  runtime). Override the interpreter with `HARNMEM_NODE=/path/to/node` if needed.
- An OpenAI-compatible endpoint **only** if you enable session-end extraction.

## Install

From the HarnMem repository:

```bash
hermes plugins install ys118/harnmem/packages/hermes-harnmem --enable
hermes memory setup          # choose "HarnMem"; the wizard writes memory.harnmem
hermes harnmem status        # verify: prints the store path and Node version
```

`hermes plugins install` clones the plugin into `$HERMES_HOME/plugins/<name>`.
The provider id is the **directory name**, so it must be `harnmem`:

```bash
ls ~/.hermes/plugins           # expect: harnmem
# A catalog install uses the catalog name harnmem; a git install may land under
# a different name — rename the directory to harnmem before enabling it.
```

For development against a checkout, copy or symlink the package directory:

```bash
# POSIX
ln -s "$PWD/packages/hermes-harnmem" ~/.hermes/plugins/harnmem

# Windows (PowerShell, run as the user)
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\hermes\plugins\harnmem" `
  -Target "D:\projects\harnmem\packages\hermes-harnmem"

HERMES_PLUGINS_DEBUG=1 hermes plugins doctor ~/.hermes/plugins/harnmem
HERMES_PLUGINS_DEBUG=1 hermes memory setup
```

Restart the Hermes process after installing or changing the plugin; tool and
provider registrations are read at startup.

## What it does

| Layer | Behaviour |
| --- | --- |
| Injection | `prefetch()` renders the HarnMem hot index and Hermes appends it to the current user message (ephemeral; the system prompt and stored transcript are untouched). The snapshot is cached per session and re-rendered only on session switch, day rollover, a memory write, or compaction, so two turns without writes inject identical bytes. Renders time out after 8 s; a failure keeps the previous injection and backs off for 60 s. |
| Tools | `harnmem_search`, `harnmem_write`, `harnmem_read`, `harnmem_forget`, `harnmem_status` (JSON results, model-readable one-line outcomes). |
| Lifecycle | Session end hands the transcript to a **detached** Node process; the provider returns immediately. Extraction is idempotent per session, skips subagents/cron sessions, and degrades to `no_llm` when no endpoint is configured. Memory write tools keep working without an LLM. |
| Config | `hermes memory setup` wizard fields plus `HARNMEM_*` environment overrides; `hermes memory status` renders the resolved store, mode, Node version and extraction readiness. |

### Tools

| Tool | Arguments |
| --- | --- |
| `harnmem_search` | `query`, optional `limit` (default 8), `scope` (`user` / `project`) |
| `harnmem_write` | `type` (`user` / `feedback` / `project` / `reference`), `title`, `description`, `content`, optional `tags`, `scope`, `importance` |
| `harnmem_read` | `id`, optional `include_history` |
| `harnmem_forget` | `id`, optional `hard` |
| `harnmem_status` | none |

## Configuration

`hermes memory setup` writes the answers to `memory.harnmem` in
`$HERMES_HOME/config.yaml`; the same keys can be edited there directly, and
`HARNMEM_*` environment variables win over the file (secrets live in
`$HERMES_HOME/.env`).

| Key | Default | Env var | Meaning |
| --- | --- | --- | --- |
| `home` | `~/.harnmem` | `HARNMEM_HOME` | Store directory shared with the other adapters |
| `project` | detected | `HARNMEM_PROJECT` | Project name for project-scoped memories |
| `inject` | `true` | `HARNMEM_INJECT` | Inject the memory snapshot into each turn |
| `max_inject_tokens` | `1200` | `HARNMEM_MAX_INJECT_TOKENS` | Token budget for the injected snapshot |
| `max_inject_chars` | `10000` | `HARNMEM_MAX_INJECT_CHARS` | Hard character cap (Hermes clamps hook output near 10k) |
| `auto_extract` | `false` | `HARNMEM_AUTO_EXTRACT` | Extract memories when a session ends |
| `read_only` | `false` | `HARNMEM_READONLY` | Never write from this profile |
| `debug` | `false` | `HARNMEM_DEBUG` | Bridge diagnostics in the Hermes log |
| `llm_url` | — | `HARNMEM_LLM_URL` | OpenAI-compatible base URL (extraction only) |
| `llm_model` | — | `HARNMEM_LLM_MODEL` | Model name for extraction |
| `llm_api_key` | — | `HARNMEM_LLM_API_KEY` | API key (written to `.env` as a secret) |

`enabled` / `HARNMEM_ENABLED` and `HARNMEM_DISABLED` toggle the provider without
uninstalling it.

## CLI

```bash
hermes harnmem status
hermes harnmem search "deployment rule" --limit 5
hermes harnmem read mem_01J8Z6Q0K4T9B2M7R5X3C8V1ND
hermes harnmem write --type feedback --title "Never force-push main" \
  --description "Shared repository requires PRs" \
  --content "Why: shared repo. How to apply: open a PR."
hermes harnmem forget mem_01J8Z6Q0K4T9B2M7R5X3C8V1ND
hermes harnmem restore mem_01J8Z6Q0K4T9B2M7R5X3C8V1ND
hermes harnmem consolidate --dry-run
hermes harnmem rebuild
```

Every subcommand accepts `--json`.

## Verification

1. `hermes plugins doctor` reports the provider as loadable;
   `hermes plugins validate <dir> --install-deps` passes.
2. `hermes memory setup` → HarnMem → `hermes memory status` shows
   `store: ~/.harnmem`, `mode: read-write`, `node: v22.15+`.
3. With an empty store, `hermes harnmem status` reports zero shards and a new
   session injects no memory text.
4. `hermes harnmem write --type user --title "Prefers pnpm" --description "Uses pnpm over npm" --content "pnpm 10"`,
   then start a new session: the snapshot contains `Prefers pnpm`, and
   `harnmem_search("pnpm")` returns it. Two turns in the same session inject
   identical bytes.
5. Ask the agent to call `harnmem_search` with a Chinese query; the result is
   non-empty when the store has CJK content (bigram tokenization works).
6. Enable extraction (`auto_extract: true` plus `llm_url`/`llm_model`/`llm_api_key`),
   run a short session, then check `hermes harnmem status` — the extraction
   backlog/writes move and `~/.harnmem/state/audit.jsonl` records the run.
7. Start a subagent session: it can search but writes are refused
   (`harnmem is read-only for this session`).

## Troubleshooting

- **Provider missing from `hermes memory setup`** — the plugin directory must be
  `$HERMES_HOME/plugins/harnmem` and `__init__.py` must import
  `agent.memory_provider`. Run with `HERMES_PLUGINS_DEBUG=1`.
- **`node` not found / version too old** — the bridge requires Node.js 22.15+.
  Install it on `PATH` or set `HARNMEM_NODE`.
- **No memories extracted** — extraction is opt-in and needs an LLM endpoint.
  Check `hermes harnmem status` for `extraction_llm: configured` and read
  `~/.harnmem/state/audit.jsonl` for `kind: "extract"` outcomes.
- **Conflicting memory from another harness** — expected: HarnMem is one store
  shared by every adapter; dedupe/supersede rules live in the engine.
- **Uninstall** — `hermes plugins remove harnmem` (or delete the directory) and
  set `memory.provider` back to the built-in provider; `~/.harnmem/` is kept.

## Privacy

Local-first: the engine never opens a network connection by itself. The single
outbound call is the extraction pass against the endpoint **you** configure,
made only when `auto_extract` is `true`. The plugin sends the session
transcript to that endpoint when extraction runs; disable extraction to keep
everything local.

## License

MIT — see [LICENSE](LICENSE).
