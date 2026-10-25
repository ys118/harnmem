# DSH write-side silence — investigation report

> Status: investigation complete; **read-only** (no file in `~/.harnmem`, the DSH profile, or the adapter source was modified).
> **Resolution (same day, later): fixed and verified end-to-end in a real DSH runtime — see §10.**
> **Follow-up (2026-10-24): quit-time extraction closed by a deferred catch-up at the next open — see §11.**
> Collected: 2026-10-23 17:15–17:35 (+08). Machine: Windows 11 x64, DSH desktop (profile `desktop`), Node 24.9.0.
> Question asked: why has the write side been silent? — i.e. why has the store produced no new memory since the DSH adapter went live?
> Evidence labels: `[V]` = directly verified on this machine (file read / command output); `[I]` = inferred from code + collected data; `[U]` = unverified, needs a controlled run.

## 0. TL;DR

- **HarnMem has never received a single write from DSH.** The only memory in the store (`<memory-id>`, "prefers pnpm over npm") was written by the **pi** adapter at `2026-10-21T12:38:00Z` (= 20:38 +08), minutes after the plugin was installed. `audit.jsonl` has exactly one `kind:"write"` event and its `harness` is `"pi"`.
- Three *independent* channels are broken, so there is no error to observe in the first place:
  1. **Model-initiated writes (`memory_write` …) never reach HarnMem** — `dsh-auto-memory` is bundled before `dsh-harnmem` and owns the `memory_*` tool names; only `memory_status` (a name auto-memory does not define) actually resolves to HarnMem. `[V]`
  2. **End-of-session extraction is gated by `realUserMessages < 3`** over a **200-event ring buffer**; in the one session where `sessionEnd` ever ran the ring held **1** user message → `too_few_messages`. Long DSH sessions structurally keep 0–1 user messages in that window. `[V]` for the observed instance, `[I]` for the general pattern.
  3. **`sessionEnd` almost never runs at all** — 10 real DSH sessions since 2026-10-21 20:37, exactly **1** transcript in `~/.harnmem/sessions/`. Dispose is fire-and-forget (`void sessions.dispose(...)`) and the quit-path flush is unverified (design doc item still unchecked). `[I]`
- The silence is complete because `dsh-harnmem` has **no file logger** and **no `log` setting** (unlike `pi-harnmem`, which writes `~/.harnmem/logs/pi.jsonl`), and `audit.jsonl` records only `inject`/`write` — there is no `extract` event (ROADMAP N13). **The `config: { log: "on" }` knob described in ROADMAP N2 step 1 does not exist in `dsh-harnmem` today `[V]`.**

## 1. Store snapshot at investigation time `[V]`

| Artifact | State |
|---|---|
| `~/.harnmem/memories/user/` | 1 memory: `<memory-id>.md` (916 B, "Package manager preference" — prefers pnpm), plus derived `MEMORY.md` (227 B) |
| `~/.harnmem/state/seq.json` | `{ "seq": 1, "shards": { "user": 1 } }` |
| `~/.harnmem/state/audit.jsonl` | 27 lines = **26 × `inject`** (13 × `dsh`, all `reason:"session_start"`; 12 × `pi` `session_start`; 1 × `pi` `resume`) + **1 × `write`** (`harness:"pi"`, `ts:1792586280467` = 2026-10-21 20:38:00 +08, `id:"<memory-id>"`) |
| `~/.harnmem/state/usage.json` | only `{ "<memory-id>": { "lastUsed": …, "usedCount": 1 } }` — **no extraction counters** |
| `~/.harnmem/logs/` | only `pi.jsonl` (30,779 B, mtime 2026-10-23 17:02:18; contains `session.start` / `session.shutdown` lifecycle + snapshot events, **0** occurrences of `extract`). **No `dsh.jsonl`.** |
| `~/.harnmem/sessions/` | only `20261022/dsh_session-<session-id>.jsonl` (139,832 B, mtime 2026-10-22 08:11:13; 200 lines: `assistant` 89 / `tool` 110 / **`user` 1**) |
| `~/.harnmem/digests/`, `~/.harnmem/trash/` | empty |
| Profile config | `~/.dsh/profiles/desktop/package.json` has `"dsh-harnmem": "link:<repo>/packages/dsh-harnmem"`; **`cordis.patch.yml` contains no `dsh-harnmem` entry**, so the adapter runs on `DEFAULT_SETTINGS` |

Injection from `dsh` **does** work (13 `inject` events), so the plugin is loaded and active in the desktop app — this is not a "plugin failed to load" story.

## 2. Channel 1 — model writes: the `memory_*` names are owned by `dsh-auto-memory` `[V]`

### 2.1 Code facts

- `dsh-harnmem` registers five tools with **literal** names: `memory_write`, `memory_search`, `memory_read`, `memory_forget`, `memory_status` (`packages/dsh-harnmem/src/tools.ts:212, 266, 301, 335, 362`; the list `TOOL_NAMES` is at `tools.ts:397`). Each `tools.register(...)` is wrapped so a failure only produces `log.warn("tool.registerFailed", …)` — no user-visible signal.
- Bundle order in `~/.dsh/profiles/desktop/package.json` (`dsh.profile.bundles`): `…, dshmarket, dsh-auto-memory, billion-context, dsh-harnmem`. **auto-memory loads first**, so it registers `memory_*` first.
- The duplicate-name policy of the DSH plugin tool registry is not documented in the repo and was **not pinned down** `[U]`: the only "duplicate" guard found in `app.asar` is `Duplicate tool declaration name` (MCP AFC path), which is a different registry.

### 2.2 Real-machine proof

| Observation | Meaning |
|---|---|
| `memory_read("<memory-id>")` — the store's *real* HarnMem id — returned `Error: memory not found: "<lower-cased id>"` (id lower-cased + kebab-cased before lookup) | The `memory_read` handler is `dsh-auto-memory`'s (kebab names), not HarnMem's `mem_01…` underscore ids |
| In real DSH sessions, every `memory_write` tool call carries `{"name": …, "description": …, "type": …, "body": …}` | That is auto-memory's schema. HarnMem's `memory_write` requires `type/title/description/content` and rejects anything else with `"memory_write: type/title/description/content are required; nothing was stored"` (`tools.ts:238`) |
| `memory_status` output is HarnMem's (`harnmem 1 · home ~/.harnmem · project <project-b>-<project-id> / user: 1 active`) | HarnMem's `memory_status` survived *because auto-memory defines no tool with that name* — the one channel that works is the one with no collision |

Documented precedent: ROADMAP §5 notes the same failure mode on the pi side ("pi silently keeps one of two duplicate tool names") and fixed it with `toolPrefix: "harnmem_"` (`~/.pi/agent/harnmem.json`). **The DSH adapter has no prefix mechanism** — `tools.ts` registers the bare names.

### 2.3 Consequence

Every "memory write" the model performs in DSH lands in `~/.dsh/memory` (auto-memory's store), which is why those entries exist while `~/.harnmem` stayed at `seq: 1`. This channel is unusable until the names are prefixed/renamed or one of the two plugins is disabled (ROADMAP N3).

## 3. Channel 2 — end-of-session extraction: blocked by `too_few_messages` `[V]` / `[I]`

### 3.1 The gate chain

`packages/core/src/harnmem.ts:646` `sessionEnd(...)`:

1. `appendSession(...)` writes the transcript **before** any gate (`:649-656`, `messages.slice(-200)`) — this is why a transcript can exist with no memory.
2. `read_only` → `auto_extract_off` → `requested` → `already_extracted` → `no_llm` are checked in order (`:659-663`).
3. `if (this.session.modelWrites >= (write.skipExtractIfModelWrote ?? 1)) return skip("model_wrote");` (`:664`).
4. `if (realUserMessages.length < (write.minUserMessages ?? 3)) return skip("too_few_messages");` (`:666`).

None of these `skip(...)` results is written to `audit.jsonl` or any file; `Option`-based logging is `ctx.logger.debug` only.

### 3.2 The one time `sessionEnd` actually ran

The single DSH transcript (`~/.harnmem/sessions/20261022/dsh_session-<session-id>.jsonl`, written 2026-10-22 08:11:13) contains 200 digest entries: **1 `user`**, 89 `assistant`, 110 `tool`. Therefore `realUserMessages.length = 1 < 3` → `skip("too_few_messages")`. That is the *only* end-of-session extraction the DSH adapter has ever attempted since 2026-10-21.

Note the timing: the session kept running until 2026-10-22 10:47:38, i.e. this dispose fired **mid-session** (reload/restart artefact), not at close.

### 3.3 Why the ring cannot hold 3 user messages

`MAX_DIGEST_ENTRIES = 200` (`packages/dsh-harnmem/src/digest.ts:12`), with `items.shift()` on overflow (`:96`). A digest entry is created for `user/message` (only when `data.source.kind === "user"`), `assistant/message`, and `tool/call` (`digest.ts:62-90`, truncation `MAX_ENTRY_CHARS = 2000`).

Measured event density: a DSH turn emits ~1 `user/message`, ~16 `assistant/message` and ~22 `tool/call` (plus `tool/result`, `step/*`, `turn/*`, `job/*` which do **not** enter the digest). So 200 digest entries ≈ **2–5 turns**.

Replaying the real digest algorithm over four completed sessions (snapshot decode described in §6):

| Session | total events | digest-eligible | real `user/message` events | user entries in final 200-window |
|---|---|---|---|---|
| `session-<session-id>` (10/22, 2.6 MB) | 2,450 | 786 | 8 | 4 |
| `session-<session-id>` (10/23, 7.8 MB) | 7,645 | 2,311 | 5 | **0** |
| `session-<session-id>` (10/22, 6.2 MB) | 5,858 | 1,976 | 4 | **0** |
| `session-<session-id>` (10/23, 5.4 MB) | 6,876 | 2,257 | 11 | **1** |

Conclusion: for real DSH sessions the `realUserMessages < 3` gate is the *normal* outcome, not an edge case. It only passes for very short sessions — e.g. the session this report was written in: 5 real user messages but already 204 digest entries (over the cap), leaving 4 user entries in the final 200-window — i.e. it passes today, with almost no margin, and would fall below 3 after two more turns.

## 4. Channel 3 — does `sessionEnd` even run? `[I]`

| Fact | Evidence |
|---|---|
| 10 real DSH sessions started/used after install (2026-10-21 20:37) | session snapshots (see §6): 10 session ids captured (elided) |
| Transcripts produced | **1** (at 08:11 mid-session) |
| Dispose wiring | `packages/dsh-harnmem/src/index.ts`: `agent/disposed` → `void sessions.dispose(agent)` (not awaited); `session/disposed` likewise; `ctx.effect` cleanup runs `closeAll()` on unload |
| Events exist in the host | `app.asar` contains `agent/disposed` (32 occurrences) and `session/disposed` (29), i.e. the listeners are on real events — the question is whether the desktop quit path waits long enough |
| Design doc checklist | `docs/design/08-dsh-adapter.md` item "After `agent/disposed`, `sessionEnd` finishes within 8s; shutdown does not hang" is still **unchecked** |

Interpretation: the single transcript is consistent with a *reload/restart* dispose (possibly the plugin-unload `closeAll()` path) rather than normal window close/quit. Normal closes plausibly terminate the process (or never emit dispose) before the async `dispose → appendSession → extract` chain finishes. Not provable from the store alone — see §7 for the controlled check.

## 5. Why nothing at all was logged `[V]`

| Layer | What exists | What is missing |
|---|---|---|
| Adapter logger | `packages/dsh-harnmem/src/log.ts` – thin bridge to `ctx.logger` with prefix `[dsh-harnmem]`; every entry is forwarded to the host logger (debug entries are *not* gated by `debugEnabled`, it is always `false` anyway) | No file sink; DSH desktop keeps no plugin log file (only crash logs). `~/.harnmem/logs/` therefore never gets `dsh.jsonl`. `resolveSettings`/`DEFAULT_SETTINGS` (`config.ts:33`) have **no `log` key at all** |
| pi adapter (contrast) | `packages/pi-harnmem/src/log.ts` + `state.ts:88` (`debug`, `log: "on"`) write `~/.harnmem/logs/pi.jsonl` | — |
| Store audit | `audit.jsonl` kinds are only `inject` and `write` | No `extract` kind (ROADMAP N13); `ExtractResult.status` / `skipReasons` are dropped by the adapter |
| ROADMAP N2 step 1 | instructs `config: { log: "on" }` for `dsh-harnmem` | That option does not exist in the dsh adapter — the step is stale and would silently do nothing `[V]` |

Because of this, the failure is indistinguishable from "nothing happened": a skipped extraction, a never-called extraction, and a disabled plugin all produce zero bytes.

## 6. Reproduction commands (as used)

DSH session snapshots are a **chain of independent zstd frames**; Node 24 can decode them frame by frame split on the zstd magic `28 B5 2F FD`:

```js
// node zstd-census.js <session.v4.jsonl.zstd>
const fs = require("fs"), zlib = require("zlib");
const buf = fs.readFileSync(process.argv[2]);
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
let idx = [], i = 0;
while ((i = buf.indexOf(magic, i)) !== -1) { idx.push(i); i += 4; }
let evs = [];
for (let k = 0; k < idx.length; k++) {
  const s = idx[k], e = k + 1 < idx.length ? idx[k + 1] : buf.length;
  let t; try { t = zlib.zstdDecompressSync(buf.subarray(s, e)).toString("utf8"); } catch { continue; }
  for (const line of t.split("\n")) if (line.trim()) try { evs.push(JSON.parse(line)); } catch {}
}
// digest replay: eligible = user/message(source.kind==="user") + assistant/message + tool/call, cap 200, shift()
const MAX = 200; let ring = [];
for (const ev of evs) {
  let e = null;
  if (ev.type === "user/message" && ev.data?.source?.kind === "user") e = "user";
  else if (ev.type === "assistant/message") e = "assistant";
  else if (ev.type === "tool/call") e = "tool";
  if (e) { ring.push(e); if (ring.length > MAX) ring.shift(); }
}
console.log({ total: evs.length, eligible: ring.length, ringUsers: ring.filter(x => x === "user").length });
```

Session paths: `~/.dsh/sessions/--<cwd-slug>--/session-<id>/session.v4.jsonl.zstd`.

Other evidence commands:

```powershell
Get-Content $HOME\.harnmem\state\audit.jsonl -Encoding UTF8
Get-Content $HOME\.harnmem\logs\pi.jsonl -Tail 6
Get-ChildItem $HOME\.harnmem\sessions -Recurse -File
Get-Content $HOME\.harnmem\sessions\20261022\dsh_session-<session-id>.jsonl |
  ForEach-Object { ($_ | ConvertFrom-Json).role } | Group-Object | Format-Table
```

Tool-collision probe (safe, read-only): call `memory_read` with an id in HarnMem's format (`<memory-id>`) from a DSH session and observe whether the id is returned unchanged (HarnMem handler) or kebab-cased / rejected (auto-memory handler).

## 7. What this explains — and what it does not

Explains: every observed fact (empty store, 1 pi-era memory, 1 transcript with 1 user entry, 13 successful injects, no error anywhere, no `dsh.jsonl`).

Does **not** yet explain: **why** `sessionEnd` ran only once. That needs one controlled observation — either (a) the file logger from `pi-harnmem` ported into `dsh-harnmem` so `plugin.apply`/`session.end`/`dispose` become visible on disk, or (b) a temporary `process.on("exit")`-style flush hook, or (c) `await` the dispose chain and watch `~/.harnmem/sessions` after a normal app quit.

## 8. Recommended next steps (ordered, minimal)

1. **Unblock writes (N3 first):** give `dsh-harnmem` a `toolPrefix` (port the pi mechanism) so it registers `harnmem_write` / `harnmem_search` / …; or rename the five tools if the intent is to keep both plugins. Otherwise the model-write path can never work in DSH.
2. **Port the file logger (N2 prerequisite):** copy `pi-harnmem`'s `log.ts` / `state.ts` file-logger layer into `dsh-harnmem` and add a `log` setting (`"off" | "errors" | "on"`, plus `debug`) writing `~/.harnmem/logs/dsh.jsonl`, including `plugin.apply`, `session.end`, `extract.skip`, `extract.result`, `dispose`. Fix ROADMAP N2 step 1 accordingly.
3. **Log the skip reason (N13):** write `{kind:"extract", harness, session, status, reason, added, superseded}` into `audit.jsonl`; surface it in `stats.extraction.skipReasons`.
4. **Fix the digest window / gate:** either keep the digest bounded by *turns or user messages* (e.g. retain the last N user messages and their following assistant/tool entries) instead of a raw 200-event ring, or lower `minUserMessages` (product decision). Interacts with compaction: after a DSH compaction the visible window is smaller, so a turn-aware collector must not depend on a full transcript.
5. **Make dispose durable:** `await sessions.dispose(...)` where the host allows it, and/or flush in a quit hook; add the 8 s budget assertion the design doc already lists.
6. **Re-run N2** once 1+2 land: hold a session with ≥3 real user messages, no explicit HarnMem write, quit normally, then check `~/.harnmem/logs/dsh.jsonl`, a new transcript, a transcript-derived extract result, and a new memory.

## 9. Open questions `[U]`

- Does the desktop quit path emit `agent/disposed` at all, and does it await plugin `ctx.effect` cleanup? (`app.asar` has the events and there are `will-quit` handlers, but the plugin-dispose ordering with the host's own shutdown was not traced.)
- When two DSH plugins register the same tool name, does the registry throw, warn, or last-write-wins? (Behaviour observed is "auto-memory wins"; the code path was not located in the packed asar.)
- Is the mid-session 08:11 dispose caused by a page reload, an app restart, or a plugin (un)load? Correlating host logs would settle it; none are enabled.

## 10. Resolution (2026-10-23, later the same day)

All three channels were repaired and the extraction path was proven end-to-end in a real DSH runtime (the installed DSH 0.2.1-rc.2 booted from a disposable ACP profile, 3 real user turns, session closed). Two report claims were refined during the fix: the tool collision is **exactly `memory_write` + `memory_read`** (`dsh-auto-memory` 0.9.0 registers `write/read/list/delete/prune/delete_all`; `memory_search`/`memory_forget`/`memory_status` are HarnMem's), and there were **five** independent blockers rather than three — the extra two only became visible once `dsh.jsonl` existed.

| # | Blocker (report §) | Fix landed |
|---|---|---|
| 1 | `memory_write`/`memory_read` shadowed by `dsh-auto-memory` (§0.1) | `toolPrefix` default `harnmem_` → `harnmem_write/search/read/forget/status`; hints render with the configured prefix |
| 2 | No file logger / no `log` setting (§5) | `~/.harnmem/logs/dsh.jsonl` JSON-line sink (chained, bounded, flushed on unload), `log: "on"|"errors"|"off"`, `HARNMEM_LOG`; `log: "on"` is the trial default |
| 3 | No `extract` audit events (N13) | core writes `kind:"extract"` for every outcome (status/reason/added/superseded/skipped/messages/userMessages) |
| 4 | 200-event ring evicts early user prompts → `too_few_messages` (§0.2) | digest eviction drops the oldest **non-user** entry first; prompts survive tool noise |
| 5 | Dispose fire-and-forget, 8 s budget vs ~11 s extraction (§0.3) | `agent/disposed`/`session/disposed` handlers return their promise; per-session in-flight dedupe; budget 60 s (20 s was still short for a 33.3 s desktop catch-up, §11); unload effect awaits `closeAll()` + `log.flush()` |
| 6 | Extraction LLM bridge (not visible in the report) | `dynamic import("@deepseek-ai/dsh-llm")` cannot resolve from a `link:` install and core swallowed the failure as `status:"done", added:0`; replaced with a local protocol bridge (frozen user message + `text-delta`/`reasoning-delta`/`finish` chunks) with reasoning-effort fallback and a 4,096-token floor |

**Verification (real runtime, `HARNMEM_HOME` = scratch home):** session 1, 3 user turns → `dsh.jsonl` `llm.response` 2,100 chars (5,926 reasoning chars) → `session.end status=done added=3`, `elapsedMs=14149`; `audit.jsonl` = 1 `inject` + 3 `write` + 1 `extract added:3`; 3 memory files on disk. Session 2 on the same store → `inject bytes:719 tokens:170` with the 3 ids, then `extract added:1`. Core 22/22 tests, adapter 25/25 tests, `pnpm -r typecheck` green.

**Measured latency changed a design assumption:** extraction on `deepseek-v4-flash` takes 10.8–14.1 s wall including hidden reasoning, so the design doc's 8 s dispose budget guaranteed a timeout; `llmTimeoutMs` is now 20,000 and the design doc (§11 delta) records the change. The host does **not** await `session/disposed` (the ACP `session/close` reply returns before extraction ends), so the budget delays only background work; at plugin unload the provider adapters are already gone and the call fails in milliseconds.

**Desktop N1 (partial, 2026-10-23 21:33):** after restarting the bundled app, the real `~/.harnmem/logs/dsh.jsonl` appeared with `plugin.apply` (trial defaults `toolPrefix:"harnmem_"`, `log:"on"`, `llmTimeoutMs:20000`), `tools.registered {count:5, of:5, prefix:"harnmem_"}` and `session.started (bytes:301, ids:1)`. A `harnmem_write` from the desktop agent produced the matching `write` event in `audit.jsonl` and a live `inject` refresh (`bytes:457`, `tokens:104`, 2 ids); `harnmem_search`/`harnmem_read` round-trip. Quit-time `session.end` is still to be observed in the desktop GUI.

**Residual unknowns (unchanged or new):** the desktop GUI quit path is still unverified against the awaited handlers (N1 continues; the load/registration/write path is verified above); the host's duplicate-tool policy is still unlocated, but the prefixed names make it irrelevant for this adapter; desktop `autoExtract` product default belongs to N13. The N3 decision (2026-10-23) is option (b): keep both memory plugins during the trial, then disable `dsh-auto-memory`/`pi-memory` after N4 migration.

## 11. Follow-up (2026-10-24): quit-time extraction

The one gap left after §10 was the desktop quit path: at `plugin_unload` the host
has already disposed the provider adapters, so the dispose-time `sessionEnd` LLM
call dies in milliseconds with `code:"NO_ADAPTER"` (observed; core used to swallow
that as `status:"done", added:0`). Fixing the adapter's timing could not help — the
model is simply not reachable at that moment.

The shipped fix makes extraction **deferred instead of lost**: the session journal
is durable, and the next time the same session is opened the adapter re-seeds the
digest from the journal and runs `sessionEnd` with `reason:"resume_catchup"` while
the LLM is alive (the desktop app resumes the last session on launch). Core's
`extract` audit events are the cross-process watermark: a completed extraction
covers `messages` up to the recorded count, only newer turns re-trigger, and LLM
failures now surface as `failed` instead of an empty success; digests below
`minDigestChars` skip as `digest_too_small`.

**Verification (headless real DSH runtime, scratch home):** a 6-entry / 3-user
journal produced `digest.hydrated {entries:6, userMessages:3}` →
`extract.catchup {status:"done", added:1}` → `audit.jsonl` `extract added:1` →
memory `<memory-id>`; the dispose that followed logged
`session.end status:"skipped" skipReason:"already_extracted"`. Core 29/29,
adapter 28/28, `pnpm -r typecheck` green.

**Verification on the real store (2026-10-24 11:18):** same flow against the
real `~/.harnmem` (no `HARNMEM_HOME` override): `digest.hydrated {entries:10,
userMessages:4}` → `llm.response {chars:1812, reasoningChars:2037,
finish:"stop"}` after 6.6 s → `extract.catchup {status:"done", added:4}` →
`session.end status:"skipped" skipReason:"already_extracted"`; `audit.jsonl`
recorded four `write` events and `extract done added:4 messages:10
userMessages:4`, and four memory files appeared (store: user 2 / project 5).
A shorter preceding run exited before the background LLM call returned (the
CLI does not keep the process alive for it), which is CLI-only — the desktop
app process persists.

**Verification in the desktop GUI (2026-10-24 11:23):** after restarting the
bundled app onto the catch-up build, the quit-time disposition was visible (five
`session.end` lines, all `too_few_messages` — the quit moment still cannot reach
a model), and the resumed session hydrated its digest from the journal
(`digest.hydrated {entries:200, userMessages:3}`) and started the catch-up
automatically. The 20 s budget was too tight for a reasoning model
(`llm.response` required 33.3 s for 1,645 chars + 5,582 reasoning chars), so the
run logged `extract.catchup {status:"failed", error:"extraction timed out after
20000ms"}` — visible and retried on the next open — while a smaller session
(`12 entries / 5 users`) completed in 14.3 s with `extract.catchup
{status:"done", added:1}`. The default budget is now 60 s. The 60 s retry then
landed the same session's extraction: on the next open,
`extract.catchup {status:"done", added:3}` after 37.3 s (2,598 answer chars +
3,453 reasoning chars) and three memory files written — the desktop GUI
quit-path loop is closed end to end.

**Residual:** sessions that are never reopened are not extracted (the journal is
kept; a turn/idle-triggered extraction would close this and is an N13 option).
The desktop restart cycle was observed live (2026-10-24 11:23); one more restart
loads the 60 s budget so the large resumed session can finish.
