# 13 · Hermes Agent adapter (Python memory provider over a Node bridge)

> Upstream research: [`docs/research/hermes-plugin.md`](../research/hermes-plugin.md) — local baseline
> **Hermes Agent v0.22.5 stable** (`2026-09-24`, local commit `bf0203a794a0`, bundled Python 3.14.9).
> The Python plugin API has no versioned contract (see R1), so the adapter targets the
> `MemoryProvider` ABC exactly as shipped in that release.
> Dependency contract: [`07-adapter-contract.md`](07-adapter-contract.md) §1 (the `HarnMem` facade) +
> `packages/core/src/types.ts` (`HARNMEM_API_VERSION = 1`, frozen). The engine is not re-implemented in
> Python: `lib/bridge.mjs` runs the vendored `@harnmem/core` build out of process, one JSON command
> per process, and all retrieval/storage logic stays in core.
> Status: implemented as `packages/hermes-harnmem`; verified end to end on a scratch `HERMES_HOME`
> (per-turn injection, cross-session recall, tool writes, `hermes harnmem status`, `hermes plugins
> validate` clean). Extraction is wired and covered by a deterministic test against a local
> OpenAI-compatible endpoint; a live-provider extraction run hit a gateway that requires a
> proprietary header (R5). Evidence tags: `[verified]` = local source read or real-machine probe,
> `[inferred]` = derived from the API shape, `[unverified]` = needs a check on another install.

## 1. Package shape and installation

Hermes plugins are Python packages discovered by directory. The provider **id is the directory
name**, which is also the value of `memory.provider`, the manifest `name`, and the CLI namespace:

```
packages/hermes-harnmem/
├── plugin.yaml           # name: harnmem — install directory name == provider id
├── __init__.py           # HarnmemMemoryProvider(MemoryProvider) + register(ctx)
├── config.py             # stdlib-only config parsing (imported by both entry points)
├── bridge.py             # Node discovery, subprocess bridge, detached extraction, payloads
├── cli.py                # `hermes harnmem status|search|read|write|forget|restore|consolidate|rebuild`
├── lib/
│   ├── bridge.mjs        # JSON command surface over the vendored engine
│   └── llm.mjs           # OpenAI-compatible LlmFn from HARNMEM_LLM_* (extraction only)
├── vendor/core/          # compiled @harnmem/core + prompts/ + data/ (committed, same pattern as claude-harnmem)
├── scripts/vendor.mjs    # `pnpm --filter hermes-harnmem build`
├── scripts/test-python.mjs
├── test/*.test.mjs       # bridge / LLM / vendor manifest tests (node --test)
├── test/python/          # provider, config, CLI and extraction tests (stdlib unittest)
└── README.md
```

`plugin.yaml` declares no Python dependencies (stdlib only) and one external dependency, Node; the `requires_hermes` gate keeps older hosts from importing the module:

```yaml
name: harnmem
version: 0.1.0
description: persistent memory for Hermes Agent — session-start recall injection, five memory
  tools (harnmem_write, harnmem_search, harnmem_read, harnmem_forget, harnmem_status), and
  bounded session-end extraction. Shares one ~/.harnmem store with the pi, Claude Code, Codex,
  opencode, DSH, Grok and Cursor adapters.
requires_hermes: ">=0.22.5"
external_dependencies:
  - name: node
    install: https://nodejs.org/en/download — Node.js 22.15 or newer must be on PATH
    check: node --version
```

Install (the directory name must stay `harnmem`):

```bash
hermes plugins install ys118/harnmem/packages/hermes-harnmem --enable
hermes memory setup          # pick "harnmem"; the wizard writes config.yaml + .env
hermes harnmem status        # provider-owned subcommand
```

`[verified]` `hermes plugins validate <dir>` passes every check (manifest, capability probe,
security scan, declared tools/hooks, no core override, isolation host). For development, junction or
symlink the working copy to `$HERMES_HOME/plugins/harnmem` and restart Hermes.

## 2. The four layers

| Layer | Hermes seam | Implementation |
|---|---|---|
| Injection | `MemoryProvider.prefetch(query, session_id)` — called before every API request and appended to the current **user message**; provider `system_prompt_block()` for the static note | Python-side snapshot cache; `bridge context` returns `sessionStart().text` capped at 10,000 chars; empty store returns `""` (0 bytes) |
| Tools | `get_tool_schemas()` + `handle_tool_call(tool_name, args, **kwargs)` → JSON string | Five `harnmem_*` tools; each maps to one `bridge` command; unknown tool / engine error → `tool_error(json)` |
| Lifecycle | `initialize(...)`, `on_session_switch(...)`, `on_session_end(messages)`, `on_pre_compress(messages)`, `shutdown()` | Bind `hermes_home`/`cwd`/`agent_context` at initialize; invalidate the cache on switch; session end spawns a **detached** bridge process; shutdown is a no-op (nothing to join) |
| Config | `memory.harnmem` block + `HARNMEM_*` env; `get_config_schema()`/`save_config()`; `get_status_config()`; `cli.py` | 10 schema fields, env overrides, provider-owned CLI, status rendering |

Non-goals, matching 07 §2: no retrieval logic, no store format handling, no journal, no
consolidation policy in the adapter.

## 3. Injection: per-turn recall with a byte-stable snapshot

`[verified]` Hermes calls `prefetch(query)` from `agent/turn_context.py:_memory_turn_start_and_prefetch`
before each model call, on a `spawn_context_thread` thread with an **8 s** join budget
(`memory_manager.py:_EXTERNAL_PREFETCH_TIMEOUT_S`), and appends the returned text to that turn's user
message (`compose_user_api_content`), never to the system prompt. Consequences:

- The system-prompt prefix cache stays untouched; the cost is prompt tokens repeated per turn, so the
  adapter **caches the block in Python** and only rebuilds it when the snapshot can have changed.
- Each bridge invocation is a fresh Node process; core's in-process snapshot cache does not survive a
  process boundary, so the cache must live in the provider (as with Claude Code's hook process).

Cache protocol (`__init__.py`), all in memory, no I/O on the hot path:

| Trigger | Action |
|---|---|
| first `prefetch` of a session | `bridge context` (reason `session_start`) |
| session id changed via `on_session_switch` | invalidate, rebuild on next turn |
| local day rollover (midnight, host timezone) | invalidate, rebuild on next turn |
| `harnmem_write` / `harnmem_forget` / `harnmem_restore` succeeded | invalidate, rebuild on next turn |
| `on_pre_compress(messages)` | invalidate (the post-compaction turn gets a fresh snapshot) |
| bridge failure | keep the previous text, log once, back off 60 s |

While the cache is valid the injected bytes are identical turn after turn; `sessionStart()` is
byte-stable in core and `[verified]` a bridge test asserts byte equality across two processes. The
block is capped twice: core's token budget (`max_inject_tokens`, default 1200) and a hard 10,000-character
cap in the bridge. `recall_status()` reports `RecallStatus(provider_label="HarnMem", count=<ids>)`, so
Hermes renders the `🧠` indicator only after a non-empty recall.

`[verified]` real session: after seeding `Prefers pnpm`, a fresh `hermes -z "Which package manager do I
prefer for Node projects?"` answered "You prefer pnpm for Node projects."; the scratch `state.db`
contains the block inside `messages.api_content` wrapped in Hermes' `<memory-context>` note, which is
the documented sidecar for what was actually sent.

## 4. Tools

Five tools, all read-only-safe when the provider runs in read-only mode:

| Tool | Params | Bridge command | Notes |
|---|---|---|---|
| `harnmem_search` | `query`, `limit`, `scope` | `search` (forced `readOnly: true`) | returns id/type/scope/title/description/snippet/score/status only |
| `harnmem_write` | `type`, `title`, `description`, `content`, `tags`, `scope`, `importance` | `write` | `source: {harness: "hermes", session: <session_id>}`; read-only mode → `tool_error` |
| `harnmem_read` | `id`, `include_history` | `read` (forced `readOnly: true`) | frontmatter + body + backlinks + optional history |
| `harnmem_forget` | `id`, `hard` | `forget` | trash by default, `hard: true` deletes; read-only mode → `tool_error` |
| `harnmem_status` | — | `status` (forced `readOnly: true`) | store home, project, shards, index health, extraction counters |

`handle_tool_call` returns a JSON string in every case, as the ABC requires; failures go through
`tools.registry.tool_error`, the same helper bundled providers use. Names are prefixed because the
manager drops names that collide with `_HERMES_CORE_TOOLS` or an earlier provider.

## 5. Lifecycle and extraction

`[verified]` `on_session_end(messages)` is called synchronously at real session boundaries (CLI exit,
`/new`, before compaction) and must return quickly (`memory_manager._each_provider`). The adapter:

1. skips unless `auto_extract` is on, the session is `primary` and not read-only;
2. converts Hermes messages to `TranscriptMessage[]` (role filtering; multimodal `content` parts
   flattened; <20,000 chars per message; ≤4 MiB total, trimmed oldest-first);
3. writes a temp payload under `<tmp>/harnmem-hermes/` and spawns `node lib/bridge.mjs --payload <file>`
   **detached**, with `stdio: DEVNULL`; the bridge deletes the payload when it finishes and stale files
   are swept at the next session end;
4. returns immediately. The engine's cross-process watermark (`audit.jsonl` `extract` events) makes
   repeated calls idempotent (`already_extracted`) and the core gates still apply (`too_few_messages`,
   `digest_too_small`, `model_wrote`).

`on_pre_compress` returns `""` and only invalidates the cache: v1 of the adapter does not implement the
v1/v2 pre-compress checkpoint API, because core already keeps the transcript journal. `shutdown()` does
not join the detached child; a Hermes exit cannot be blocked by extraction.

## 6. The Node bridge

`lib/bridge.mjs` is the only place that touches the engine. One process = one command:

```
stdin (or --payload <file>): {"command": "...", "cwd": "...", "home": "...", "sessionId": "...",
                              "readOnly": false, "injectTokens": 1200, "autoExtract": false,
                              "project": "...", "debug": false, "llm": {...}, ...}
stdout: exactly one line — {"ok": true, ...} or {"ok": false, "error": "...", "code": "..."}
exit:   0 = a JSON answer was produced (including ok:false engine errors), 2 = usage/payload error
```

Commands: `ping`, `context`, `session-end`, `write`, `search`, `read`, `forget`, `restore`, `status`,
`consolidate`, `rebuild`. Engine config mapping: `harness: "hermes"`, `budget.injectTokens`,
`write.autoExtract`, `readOnly` for every query command. `context` calls
`sessionStart({sessionId, cwd, reason})` and returns `{text, ids, tokensEstimate, reason, snapshotAt,
bytes, truncated}`.

Extraction LLM: `createLlmFromEnv()` reads `HARNMEM_LLM_URL` / `HARNMEM_LLM_MODEL` /
`HARNMEM_LLM_API_KEY` / `HARNMEM_LLM_TIMEOUT_MS` — exactly the variables `@harnmem/cli synonyms` uses —
and posts an OpenAI-compatible `chat/completions` request (no custom headers, mirroring the CLI
convention). The adapter passes `llm` to core **only** when `auto_extract` is on.

## 7. Config, setup and CLI

`get_config_schema()` returns 10 fields (Hermes renders them in `hermes memory setup` and persists the
answers):

| Key | Env | Default | Meaning |
|---|---|---|---|
| `home` | `HARNMEM_HOME` | `~/.harnmem` | store root (shared with every other adapter) |
| `project` | `HARNMEM_PROJECT` | auto | explicit project id override |
| `inject` | `HARNMEM_INJECT` | `true` | per-turn recall injection |
| `max_inject_tokens` | `HARNMEM_MAX_INJECT_TOKENS` | `1200` | token budget handed to the engine (100..8000) |
| `max_inject_chars` | `HARNMEM_MAX_INJECT_CHARS` | `10000` | hard character cap after rendering (500..100000) |
| `auto_extract` | `HARNMEM_AUTO_EXTRACT` | `false` | session-end extraction (needs the LLM triple below) |
| `read_only` | `HARNMEM_READONLY` | `false` | inject + read tools only |
| `llm_url` / `llm_model` | `HARNMEM_LLM_URL` / `HARNMEM_LLM_MODEL` | — | OpenAI-compatible endpoint |
| `llm_api_key` | `HARNMEM_LLM_API_KEY` | — | secret, written to `.env` by the wizard |
| `debug` | `HARNMEM_DEBUG` | `false` | bridge logs to stderr |

`[verified]` Hermes' generic setup flow keeps the answers in a **detached** dict for a provider it has
never configured (`config["memory"].get(name, {})` returns a fresh `{}`), so `save_config(values,
hermes_home)` must persist `memory.harnmem` itself — the adapter does that and is covered by a test.
`get_status_config()` renders store/mode/inject/auto_extract/node, which is what `hermes memory status`
shows.

`cli.py` exposes `hermes harnmem <action>` (status/search/read/write/forget/restore/consolidate/rebuild,
`--json` everywhere). Hermes discovers the module through `discover_plugin_cli_commands()` and looks up
the handler by `f"{provider}_command"`; because the loader executes `cli.py` inside a synthetic package
shell without running `__init__.py`, the CLI module must not import the provider class — it imports
`config.py` and `bridge.py` only, and a PEP 562 `__getattr__` keeps the `*_command` lookup working even
if the install directory is renamed. `[verified]` `hermes harnmem status` works on a real install.

## 8. Subagents, profiles and isolation

`[verified]` `initialize(session_id, **kwargs)` receives `hermes_home`, `platform`, `agent_context`
(`primary`/`subagent`/`cron`/`flush`), `cwd`, `agent_identity` and `agent_workspace`. The adapter:

- binds every path from the `hermes_home` kwarg (never from `__init__`, never module-level), because
  one plugin instance can serve different profiles over time;
- treats any non-`primary` context as read-only: no writes, no extraction, no `harnmem_write`
  (the manager also redacts tool args, so this is defense in depth);
- keeps all state on the instance: no module-level caches, no globals, mirroring the ABC's
  multiplexing contract;
- re-reads config from the plugin block lazily, so a `hermes config set` takes effect for the next
  session.

## 9. Packaging and distribution

The adapter is not published to npm (no Python console entry point is needed). Distribution paths:

1. **Git install** (documented today): `hermes plugins install ys118/harnmem/packages/hermes-harnmem
   --enable` clones the repo and copies the subdirectory to `$HERMES_HOME/plugins/harnmem`.
2. **Hermes plugin catalog** (follow-up): submit `plugin-catalog/harnmem.yaml` with `repo: 
   https://github.com/ys118/harnmem`, `subdir: packages/hermes-harnmem`, a 40-hex `sha` pin (the
   catalog rejects unpinned entries and runs `hermes plugins validate` at the pinned commit),
   `category: memory`, `requires_hermes: ">=0.22.5"` and the `capabilities` block. The directory name
   in the catalog determines the provider id, so the catalog entry must be `harnmem`.

The package stays a workspace member with `"private": true`; its build is `node scripts/vendor.mjs`
(copies `packages/core/dist`, `prompts/` and `data/` into `vendor/core`, same pattern and rationale as
`claude-harnmem`), and its test command chains `node --test test/*.test.mjs` with
`node scripts/test-python.mjs` (which skips cleanly when no Python 3 interpreter exists).

## 10. Risks

| # | Risk | Evidence | Handling |
|---|---|---|---|
| R1 | **No versioned plugin API**: Hermes has no `PLUGIN_API_VERSION`; compatibility is behavioral, hooks receive keyword payloads, internal imports are not API | `plugins/AGENTS.md`; a 2026-09 compatibility-layer removal precedent | target the v0.22.5 ABC only, keep `**kwargs` on hooks, use `hermes plugins validate` as a release gate, pin catalog SHAs, re-run validation on every Hermes stable |
| R2 | **Catalog rule 9**: private core imports break on any release | first `validate` warned about `bridge.py` imports of `tools.environments.local` | fixed: `bridge.child_env()` now only copies `os.environ` and prepends Node's directory to `PATH`; `[verified]` re-validation has zero warnings |
| R3 | **Prefetch is synchronous with an 8 s budget** and runs per turn | `memory_manager.py` (`_EXTERNAL_PREFETCH_TIMEOUT_S = 8.0`) | the bridge is one short Node process; on failure the provider keeps the previous text and backs off 60 s; never raises out of `prefetch` |
| R4 | **Node is a new host requirement** (Hermes itself is pure Python) | `external_dependencies` check | declared in the manifest, probed with `HARNMEM_NODE` override and a version gate (≥22.15); `unavailable_reason()` explains the fix |
| R5 | **Extraction endpoints must be plain OpenAI-compatible** | live probe: the machine's `opencode-go` gateway returned HTTP 400 `MissingSessionID` (needs `x-opencode-session`), so the same `HARNMEM_LLM_*` variables that work for the CLI cannot reach it | documented limitation; the failure is surfaced as `status: "failed"` with the HTTP error (not silent); custom headers are a follow-up shared with the CLI |
| R6 | **Spill threshold**: prefetch output above ~100k chars (or `memory.prefetch_spill_enabled` off) is spilled to a file by Hermes | `memory_manager.py` spill config | the bridge caps at 10,000 chars, far below the limit |
| R7 | **Detached extraction may not finish** if the host exits immediately | `on_session_end` is fire-and-forget | payload file + core watermark make a retry harmless; nothing in the session path waits on it |
| R8 | **Renaming the install directory** changes the provider id and breaks the CLI handler lookup | discovery uses `child.name`; CLI handler is `f"{provider}_command"` | README states the constraint; `cli.py` has a PEP 562 fallback; `hermes memory setup` writes whatever id is installed |

## 11. Acceptance checklist (07 §8, Hermes-specific evidence)

| 07 §8 item | Status | Evidence |
|---|---|---|
| Empty store injects 0 bytes | `[verified]` | bridge test; real session with an empty store injected nothing |
| A memory written now is visible in a new session | `[verified]` | `hermes -z` seed → new `hermes -z` recall; api_content sidecar shows the block |
| Chinese query hits (bigram) | `[verified]` | bridge test seeds Chinese records and searches them |
| Two turns inject identical bytes | `[verified]` | cache test: two prefetches without a trigger return the same text; bridge byte-stability test across processes |
| Session exit does not hang | `[verified]` | session end only writes a payload and spawns a detached child; no join in `shutdown` |
| Read-only with no LLM / no write permission | `[verified]` | subagent context and `read_only` tested; write/forget return `tool_error`; query commands force `readOnly` |
| Subagents do not duplicate writes | `[verified]` | `agent_context != "primary"` short-circuits extraction and write tools |
| Migrated data searchable, not duplicated | `[verified]` | the shared store is the same core store the other adapters use; extraction is ADD-only + audit watermark |

Hermes-specific checks: `hermes plugins validate` clean `[verified]`; provider visible and
`Status: available` in `hermes memory status` `[verified]`; `hermes harnmem status` `[verified]`;
`register()` succeeds in isolated capability probe `[verified]`.

## 12. Follow-ups

- Hermes browser/desktop panel (not part of v1; the CLI and tools cover observation).
- `on_pre_compress` checkpoint API v2 (fail-closed archive before compaction) once users run with
  compaction-heavy sessions.
- Catalog submission and a `--ref`-pinned release policy.
- Optional `HARNMEM_LLM_HEADERS` (JSON object) so gateways that need proprietary headers — such as the
  `opencode-go` endpoint observed here — can serve extraction; the CLI needs the same flag to stay
  consistent.
- Optional shared per-turn dedupe: if the provider could remember what the previous turn already
  injected, the same block could be skipped on retries; today the cache rebuilds only on real changes,
  which is the safer default.
