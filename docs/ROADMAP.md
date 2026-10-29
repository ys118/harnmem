# Roadmap and current status

Single source of truth for **where the project stands and what to do next**.
Design intent lives in [`design/`](design/); this file tracks execution state.

Last updated: **2026-10-28** (N15 codex-harnmem shipped: implementation + real-machine acceptance complete).

## 1. Snapshot

| Item | State |
| --- | --- |
| Repository | `github.com/ys118/harnmem` (public), branch `master`, CI green on `a731f2f` |
| Latest release | `v0.2.0` tag on `a731f2f` (DSH adapter + write-silence fix + resume catch-up + single-store migration) |
| Commits after `v0.1.0` | `b872c86..a731f2f` — DSH adapter and cold-start fix, toolPrefix/order coexistence, the DSH write-silence fix, resume catch-up, and the N4/N5 single-store migration |
| Packages (all `0.2.0`, published on npm) | `@harnmem/core`, `@harnmem/cli`, `pi-harnmem`, `dsh-harnmem` |
| Core tests | 52/52 pass (`node --test packages/core/test/*.test.mjs`); adapter 58/58 (`pnpm --filter dsh-harnmem test`) |
| Evaluation | functional gates PASS; macro R@10 1.000, MRR 0.891, nDCG@10 0.911; 5 advisory perf gates (see §3) |
| Real trial | N1 closed 2026-10-25, verdict **useful**; single store since 2026-10-24: legacy memories migrated (N4/N5), `dsh-auto-memory`/`pi-memory` disabled and their stores later deleted, HarnMem is the memory SSOT (user decision 2026-10-25) |
| Environment | Windows 11, Node 24.9.0, pnpm 10.33.2, pi 1.3.0, DeepSeek Harness 0.2.1-rc.2 |

**Live trial evidence** (`C:\Users\<user>\.harnmem`):

- 1 real memory captured (`<memory-id>`, user feedback: "prefers pnpm"),
  written through the pi adapter's `harnmem_write`.
- 27 audited events: 26 injection events (13 `dsh` + 13 `pi`: 25 `session_start`,
  1 `resume`) plus 1 write. Both adapters inject byte-stable snapshots at
  session start.
- No writes or extraction failures observed in either harness; `extract pending 0, failed 0`.
- (Resolved 2026-10-24) auto-extraction was initially silent — proven and fixed
  in N2; the final N1 verdict with trial-wide numbers is in §5 "Trial notes".

## 2. What is running right now

### pi (real install, `packages/pi-harnmem`)

- Installed with `pi install <repo>\packages\pi-harnmem`; it coexists
  with `pi-memory`, which owns the `memory_*` tool names.
- Trial config `~/.pi/agent/harnmem.json`:

  ```jsonc
  {
    "toolPrefix": "harnmem_",   // harnmem_write/search/read/forget/status
    "autoExtract": false,       // no background LLM call during the trial
    "log": "on",
    "debug": true
  }
  ```

- Logs: `~/.harnmem/logs/pi.jsonl` (~30 KB during the trial; `log: errors` is
  the quieter production setting).
- pi-memory still injects its own snapshot; both extensions inject memory in the
  same turn. This is intentional for the trial and must be decided in N3.

### DSH desktop (real profile, `packages/dsh-harnmem`)

- Installed with `dsh plugin --profile desktop add <repo>\packages\dsh-harnmem`.
  The profile has `"dsh-harnmem": "link:<repo>/packages/dsh-harnmem"`
  in `dependencies` and `dsh-harnmem` in `dsh.profile.bundles`.
- `@harnmem/core` is wired through a **manual junction** in the profile's
  `node_modules` — this works locally but is *not* a user-installable setup yet.
  Publishing `@harnmem/core` first fixes it (N7).
- Injection section order is **4050** (`dsh-auto-memory` uses 4000), so when both
  plugins are installed the order is deterministic: auto-memory, then HarnMem.
- Adapter defaults (schema; the profile has no explicit config): `injectMaxTokens:
  1200`, `hotEntries: 24`, `autoExtract: true`, `projectScope: true`,
  `llmTimeoutMs: 60000`, `minUserMessages: 3`, `log: "on"` during the trial,
  `toolPrefix: "harnmem_"`.
  The five tools are therefore `harnmem_write/search/read/forget/status`; the
  bare `memory_write`/`memory_read` names belong to `dsh-auto-memory` (the first
  registrant wins in DSH, N2 incidentally proved that with tools 3/5 only).
- Logs: `~/.harnmem/logs/dsh.jsonl` (JSON lines; `log: "errors"` is the quieter
  setting, `HARNMEM_LOG` overrides). It records `plugin.apply`,
  `session.created`, `session.end` (status/added/skipReason/digest size),
  `session.endTimeout`, and the extraction LLM bridge (`llm.call`,
  `llm.response`, `llm.callFailed`).
- `llmTimeoutMs: 60000` bounds extraction. A real extraction (3 memories,
  ~2.1 KB JSON) measured 10.8–14.1 s on `deepseek-v4-flash` (reasoning tokens
  included), so the old 8 s budget cut **every** real extraction off — the
  timeout was one of the reasons desktop never wrote a memory (N2,
  2026-10-23). The attach-time catch-up on the desktop host then measured
  33.3 s for a 6,000-char digest on `<provider>/<model>` and
  tripped the 20 s budget (trial note 2026-10-24 11:23), so the default moved
  to 60 s. At process unload the provider adapters are already gone, so the
  call fails in milliseconds and shutdown does not hang.
- **Quit-time extraction is deferred, not lost (2026-10-24).** The host tears
  the provider adapters down before `plugin_unload`, so no LLM call can run at
  quit (observed `code:"NO_ADAPTER"` in milliseconds). The session journal
  (`~/.harnmem/sessions/<yyyymmdd>/dsh_<sessionId>.jsonl`) is durable, and the
  next time that session is opened the adapter re-seeds the digest from it and
  runs `sessionEnd` with `reason:"resume_catchup"` while the LLM is alive (the
  desktop app resumes the last session on launch). Core's `extract` audit
  events are the cross-process watermark: a completed extraction covers
  `messages` up to the recorded count, only newer turns trigger another run, and
  `already_extracted`/`digest_too_small` are explicit skip reasons while LLM
  failures surface as `failed` (never a silent `done added:0`).
- **Read-only memory browser panel (2026-10-24).** The DSH web GUI — the desktop
  app included — shows a "Memory" icon in the left sidebar (`sidebar.panellist`,
  id `harnmem`, order 60) that opens the store without touching it: Overview,
  Memories, Detail, Index and Injection-preview views backed by six read-only
  `GET /api/harnmem/*` routes over `MemoryInspector` in `@harnmem/core`. No new
  config keys and no new dependencies; writes still belong to the model tools and
  the CLI. Verified on a scratch web runtime against the real store (4 shards /
  54 records, all six routes 200; injection preview = 24 ids, ~1,183 tokens).
  Details: [`design/08-dsh-adapter.md`](design/08-dsh-adapter.md) §12 and the
  "Memory browser panel" section of `packages/dsh-harnmem/README.md`.
- Session journals: `~/.harnmem/sessions/<yyyymmdd>/dsh_<sessionId>.jsonl`
  (one 139 KB journal from 2026-10-22; the 2026-10-23 verification runs added
  short journals with 6 messages each).

### Disable or remove (without touching the data)

- **pi:** remove the path from the `packages` array in `~/.pi/agent/settings.json`
  (or run `pi uninstall <package>` if your pi version supports it), then start a
  new pi session. Tool calls made by the extension stop immediately; memory
  files stay in `~/.harnmem`.
- **DSH:** `dsh plugin --profile desktop remove dsh-harnmem`, then restart the
  DSH app (plugins load only at startup). Remove the `@harnmem/core` junction
  from the profile's `node_modules` only if you also uninstall the plugin.
- The memory store (`~/.harnmem/`) is independent of the plugins: uninstalling
  never deletes memories. Use `harnmem forget <id>` / `trash/` for that.

## 3. Known issues and limitations

Ordered by impact; **do not silently skip these**.

1. **Extraction is proven in a real DSH runtime (resolved 2026-10-23).** A
   disposable ACP profile booting the installed DSH 0.2.1-rc.2 ran 3 real user
   turns, `agent/disposed` fired, the digest held 6 entries / 3 user messages,
   `session.end` reported `status=done added=3`, `audit.jsonl` gained
   `kind:"extract" status:"done" added:3`, three memory files were written, and
   the next session injected them (719 B / 170 tokens). The old failure chain is
   described in `docs/research/dsh-write-silence-2026-10-23.md`; each link is
   fixed here (tool prefix, file log, audit extract event, digest prompt
   preservation, 60 s extraction budget, local LLM protocol bridge, awaited
   dispose). The desktop GUI write path is verified (2026-10-23, trial note
   below); the **quit path is closed 2026-10-24 by deferred catch-up**: the host
   disposes the provider adapters before `plugin_unload` (observed
   `code:"NO_ADAPTER"`), so the write happens on the next open of the same
   session instead (§2). Headless real-runtime E2E: a 6-entry/3-user journal was
   hydrated on open, extracted with `reason:"resume_catchup"`
   (`extract.catchup status=done added=1`; `audit.jsonl` `extract added:1`; one
   memory file written), and the dispose that followed logged
   `session.end status=skipped skipReason=already_extracted`. The real desktop
   GUI cycle is watched too (2026-10-24 11:37, trial note below:
   `extract.catchup status=done added=3` after 37.3 s on the 60 s build).
   **Remaining:** sessions that are never reopened are not extracted
   (turn/idle-triggered extraction is an N13 option); decide the product default
   for `autoExtract` in N13.
2. **10k-store performance is v0.2 work**: one-off import ~11–12 s; first query
   per shard 0.5–1.4 s (JSON parse); on-disk index ~2.9× the canonical `.md`
   store (47× if the denominator is body text only); warm search p95 ~16–22 ms.
   These are the 5 advisory gates in `evals/results/eval-report.md`.
3. **Ranking, not recall, is the weak spot**: S8 cross-language P@1 0.225 and
   S11 noisy-text P@1 0.333 while R@10 is 1.000. Candidate for N11.
4. **DSH install path is trial-only** (`link:` dependency + manual core junction;
   desktop profile cannot be booted from the CLI). Real runtime evidence comes
   from a disposable profile with a local mock endpoint, plus the live trial
   above. A normal `dsh plugin add dsh-harnmem` install needs the npm release (N7).
5. **Coexistence cost**: with both memory plugins installed, two snapshots are
   injected (auto-memory's project index + HarnMem's hot index, ~1.2 K tokens
   each). The `harnmem_*` prefix removed the functional collision; the token
   cost remains. N3 decided (b) — keep both during the trial, then disable
   `dsh-auto-memory`/`pi-memory` after N4.
6. **pi adapter default `autoExtract: false`** vs DSH adapter default `true` —
   intentional in the trial, but the product default should be decided in N13.
7. **ZCode importer is unverified** (no `~/.zcode` data on this machine);
   `unresolved` buckets are handled but have no real fixture.
8. **npm release workflow fails by design** (`ENEEDAUTH`) until `NPM_TOKEN` and
   the `@harnmem` scope exist; provenance signing also requires a public repo.
9. **Dependabot `npm_and_yarn` job fails** on workspace `link:` dependencies —
   harmless; ignore or disable that ecosystem in `.github/dependabot.yml`.
10. **Claude Code adapter** is implemented as a plugin package
   ([`packages/claude-harnmem`](../packages/claude-harnmem/README.md), 2026-10-26);
   see [`design/09-claude-adapter.md`](design/09-claude-adapter.md) and
   [`research/claude-code-plugin.md`](research/claude-code-plugin.md).

## 4. Next steps

Work top-down. Each item is self-contained: goal → actions → acceptance.
Check boxes as items land, and update this file when the status changes.

### Phase A — finish the real trial (decision gate)

- [x] **N1. Run the trial for a few more real sessions.**
  *(Closed 2026-10-25 — the wrap-up with numbers and the usefulness verdict is
  in §5 "Trial notes"; remaining gaps stay tracked in N13 (never-reopened
  sessions) and N12 (project identity split).)*
  Use pi and DSH normally for 2–3 days (both plugins on). Look at:
  ```powershell
  node packages/cli/dist/main.js stats --home $HOME\.harnmem
  Get-Content $HOME\.harnmem\state\audit.jsonl -Tail 20
  Get-Content $HOME\.harnmem\logs\pi.jsonl -Tail 20
  ```
  Record: injection bytes per session (audit `bytes`), token overhead, whether
  any memory was captured and whether any recall was actually useful.
  *Desktop N1 (2026-10-23 21:33, after restarting the bundled app):* the real
  `~/.harnmem/logs/dsh.jsonl` appeared with `plugin.apply` (defaults
  `toolPrefix:"harnmem_"`, `log:"on"`, `llmTimeoutMs:20000`),
  `tools.registered {count:5, of:5, prefix:"harnmem_"}`, `session.started
  (bytes:301, ids:1)`. A `harnmem_write` from the desktop agent produced a
  `write` audit event plus a `memory_write` injection refresh (457 B / 104
  tokens, 2 ids) and a project memory file; `harnmem_search`/`harnmem_read`
  round-trip. **Quit-path gap (2026-10-23):** `logs/dsh.jsonl` has zero
  `session.end` lines and `audit.jsonl` zero `"kind":"extract"` events for the
  whole day, yet the 21:33:15 quit appended all 13 open session transcripts at
  once (`sessions/20261023/*.jsonl`, mtime `13:33:15.16–.20Z`; this session's
  200-line transcript is one of them) — the dispose chain ran, but extraction
  did not finish or log before the host exited. The 21:52:46 restart left no
  dispose trace at all (hard quit). Since 6cea64f the quit path is closed by
  deferred catch-up — verified on the real store (2026-10-24, trial notes
  below): a resumed session logged `digest.hydrated {userMessages:4}` →
  `extract.catchup {status:"done", added:4}` → `session.end
  skipReason:"already_extracted"`. **Still to observe:** the desktop-GUI attach
  path once the app restarts onto 6cea64f (open an old session whose journal
  has ≥3 user messages, or accumulate ≥3 prompts before quitting), and the
  2–3 day usefulness verdict.
  *Acceptance:* a short trial note in this file (append under §5) with numbers
  and a verdict on usefulness.

- [x] **N2. Verify DSH end-of-session extraction.** *(2026-10-23, verified —
  see the evidence below; the desktop GUI repeat is folded into N1.)*
  The investigation (`docs/research/dsh-write-silence-2026-10-23.md`) found
  **five** independent silent blockers, not three: (1) `memory_write` /
  `memory_read` were shadowed by `dsh-auto-memory`; (2) the digest ring evicted
  early user prompts before the 200-event window filled, so
  `too_few_messages` skipped; (3) `agent/disposed` was fire-and-forget and the
  process usually died first; (4) even when it fired, the 8 s budget raced a
  ~11 s extraction and closed the engine; (5) the extraction LLM bridge used a
  dynamic `import("@deepseek-ai/dsh-llm")` that cannot resolve from a linked
  package, and core silently turned that into `status:"done", added:0`.
  Fixed in this commit: `harnmem_*` tool prefix, `~/.harnmem/logs/dsh.jsonl`
  file log (`log: "on"` default), `kind:"extract"` audit events (N13),
  user-prompt-preserving digest eviction, 60 s extraction budget, local LLM
  protocol bridge with reasoning-effort fallback, dispose handlers return their
  promise, and awaited unload cleanup.
  *Verification:* a disposable ACP profile booting the installed DSH 0.2.1-rc.2
  ran 3 real user turns and closed the session; `dsh.jsonl` logged
  `llm.response` (2100 chars, 5926 reasoning chars) then
  `session.end status=done added=3`; `audit.jsonl` recorded 3 `write` events and
  one `extract` event (`added:3`); three memory files appeared; a second session
  on the same store injected them (`bytes:719`, `tokens:170`) and extracted one
  more memory. Core 22/22 and adapter 25/25 tests are green.
  *Acceptance:* met in the real runtime; desktop GUI confirmation remains in N1.

- [x] **N3. Decide the coexistence policy. — decided 2026-10-23: option (b).**
  Options were: (a) keep both memory plugins long-term (redundant tokens,
  safest migration), (b) migrate legacy memories, then disable
  `dsh-auto-memory` and `pi-memory` and use HarnMem alone, (c) keep them for
  harness-specific behavior and disable HarnMem injection per harness.
  **Decision:** adopt (b). The `harnmem_*` prefix plus prompt order 4050 removed
  the functional collision, so the two plugins can coexist during the trial;
  but two SSOTs drift and cost ~2.4 K injected tokens per session, so after N4
  imports and verifies the legacy stores, disable `dsh-auto-memory` (DSH) and
  `pi-memory` (pi). *Execution deferred to N4 completion; apply the config
  changes then.*
  *Executed 2026-10-24 (N4 done):* removed `dsh-auto-memory` from
  `~/.dsh/profiles/desktop/package.json` (both the dependency and
  the `dsh.profile.bundles` row) and its `- id: auto-memory` override from that
  profile's `cordis.patch.yml`; removed `npm:pi-memory` from
  `~/.pi/agent/settings.json` and re-enabled `autoExtract` for
  `pi-harnmem` (`~/.pi/agent/harnmem.json`). Pre-change copies are
  in `.tmp/n3-backup-20261024-1205/` (restore them to roll back). Takes effect
  on the next DSH/pi start: confirm `plugin.apply` no longer lists
  `dsh-auto-memory` and that only `harnmem_*` memory tools remain.
  *Verified 2026-10-24 15:07 (desktop restart):* `dsh.jsonl` shows
  `plugin.apply` → `tools.registered {count:5, of:5, prefix:"harnmem_"}` →
  `session.started {bytes:5835, ids:24}`, with no `registerFailed` and no
  warnings. `~/.dsh/memory/audit.jsonl` (auto-memory's own injection audit)
  stayed frozen at 12:01 — it recorded nothing after the restart, so the plugin
  is not loaded. Single-store runtime confirmed: user 14 / <project-a> 23 /
  <project-b> 4 / harnmem 10, index fresh, 0 duplicate candidates, 0 orphans.
  Old chat sessions may keep the tool list they were created with; open a new
  session to see the `harnmem_*` tools.
  *Cleaned up 2026-10-24 (legacy files):* the leftover desktop-profile
  `node_modules` copy was pruned with `dsh plugin --profile desktop install`
  (5 packages removed: `dsh-auto-memory` and its deps; lockfile references 0),
  and `~/.dsh/memory` (35 files, 131 KB) was deleted after the N4
  import backups under `~/.harnmem/state/backups/mig-*` were verified to hold
  full source copies and the merged store was spot-checked. Remaining textual
  mentions are intentional: the disabled-plugin breadcrumb in the profile's
  `cordis.patch.yml`, the marketplace catalog/log under
  `~/.dsh/profiles/desktop/.dsh-market/`, and the rollback copy in
  `.tmp/n3-backup-20261024-1205/`. The pi legacy store `~/.pi/agent/memory`
  stays untouched until the pi-memory cleanup is decided.

### Phase B — one store, real data

- [x] **N4. Migrate the existing legacy stores into `~/.harnmem`.**
  Dry-run first; imports back up the source and are idempotent.
  ```powershell
  # DSH auto-memory (~/.dsh/memory) + pi-memory (~/.pi/agent/memory)
  node packages/cli/dist/main.js import dsh --apply
  node packages/cli/dist/main.js import pi  --apply --project <repo>
  node packages/cli/dist/main.js import list
  node packages/cli/dist/main.js import verify <runId>
  # second run must report 0 new:
  node packages/cli/dist/main.js import dsh --apply
  node packages/cli/dist/main.js import pi  --apply --project <repo>
  ```
  Note: pi's `daily/` entries have no project identity; keep them in
  `unresolved` unless `--project`/`--path-map` is right. Do **not** import
  secrets or the real memory directories themselves — imports write only to
  `~/.harnmem`, and source files are checksummed.
  *Acceptance:* merged store has the expected counts, second run adds 0,
  `import verify` passes, rollback (`import rollback <runId>`) works on a
  scratch home.

  *Done (2026-10-24).* Real apply on `~/.harnmem`: `import dsh`
  imported 30 records (21 project / 5 feedback / 2 reference / 2 user; by
  project: <project-a>-<project-id> 23, <project-b>-<project-id> 4,
  harnmem-438dc3c76d 1, user 2) and `import pi` imported 10 user-scope
  records, leaving 22 pi `daily/` blocks unresolved (content inspection showed
  cross-project tooling notes, so forcing `--project` would misattribute
  them). Each run backed up the source under
  `~/.harnmem/state/backups/<runId>/`; `import verify
  mig-20261024T035400Z-xu092w` and `...-ek35re` reported 30/30 and 10/10 ids
  present with sources unchanged, and second runs imported 0. Rollback was
  rehearsed on a scratch copy of the home first (30 + 10 ids forgotten, 0
  missing, baseline counts restored). The rehearsal also exposed orphaned
  `[[wiki links]]`: imported records carried source slugs as links, so
  `import` now pre-assigns ids and remaps links to them
  (`packages/cli/src/pipeline.ts`); the real dsh run resolved 21 links and
  dropped 0 targets outside the batch. Historical duplicate project rows
  (path-key vs git-key identities for the same repos) are left to the future
  doctor/normalize step.

- [x] **N5. Validate the merged store.**
  Run `harnmem stats`, a handful of real queries per project, check scopes
  (user vs project) and duplicates; add a `tagmap.json` only if the pi tag
  vocabulary needs mapping.
  *Acceptance:* no cross-project leaks, no duplicate candidates, search results
  judged useful by hand.

  *Done (2026-10-24).* `harnmem stats` after the import: user 14 / harnmem 9 /
  <project-a> 23 / <project-b> 4 active records, index rebuilt, 0 orphans.
  Scope spot checks: from `<repo>`, `search pnpm` returns only
  user-scope + harnmem hits (no foreign-project leak); `search data/` returns
  one user-scope global memory (legitimately visible everywhere);
  `--project <project-a>-<project-id> search promotion-rules` returns 12
  project hits; `--project <project-b>-<project-id> search windows` returns its
  own records. The single pre-existing duplicate candidate (two near-identical
  user memories about answer language and conclusion-first style, created by
  the N2 catch-up test) was moved to trash
  (`<memory-id>`, restorable with `harnmem restore`);
  duplicate candidates went 1 -> 0. No `tagmap.json` was needed.

### Phase C — release v0.2.0

- [x] **N6. Bump and tag.**
  Version `0.2.0` in all four packages, `CHANGELOG.md` entry ("DSH adapter,
  cold-start injection, toolPrefix coexistence, section order"), commit, push,
  tag `v0.2.0`, confirm CI and the release workflow (publish still expected to
  fail without npm credentials).
  *Acceptance:* tag on a green commit; `git log v0.1.0..v0.2.0` tells the story.
  *Done 2026-10-24:* bumped all four packages to `0.2.0` and dated
  `CHANGELOG.md` as `[0.2.0] - 2026-10-24` (commit `a731f2f`), tagged
  `v0.2.0` and pushed `master` + the tag. CI run
  [40060992327](https://github.com/ys118/harnmem/actions/runs/40060992327) is
  green; the tag-triggered Release run
  [40060996150](https://github.com/ys118/harnmem/actions/runs/40060996150)
  passed install/build/typecheck/test/eval and failed only at "Publish
  packages" with `ENEEDAUTH` (no `NPM_TOKEN` secret / `@harnmem` npm org
  yet) — exactly the expected N7 blocker.

- [x] **N7. Publish to npm (publish order matters).** ✅ 2026-10-25 — all four
  packages live at 0.2.0 with `latest` tags correct:
  [@harnmem/core](https://www.npmjs.com/package/@harnmem/core),
  [@harnmem/cli](https://www.npmjs.com/package/@harnmem/cli),
  [pi-harnmem](https://www.npmjs.com/package/pi-harnmem),
  [dsh-harnmem](https://www.npmjs.com/package/dsh-harnmem).
  Pre-publish fixes: pi peer ranges widened to `>=1.3.0 <2` (0e7005f; upstream
  pi is at 1.4.0 and the adapter is verified there), `publishConfig.provenance`
  removed from all four (8fafaf6; local publish cannot mint provenance — CI's
  explicit `--provenance` in release.yml is unaffected). Publishing required
  the maintainer's terminal: account 2FA is auth-and-writes, so chat-relayed
  TOTP codes expired in transit (`EOTP` ×2); the interactive browser-OTP flow
  succeeded. Note: an extra stray publish from a pre-repo checkout had created
  `0.0.0-stage` versions of pi-harnmem/dsh-harnmem; both were unpublished the
  same day (registry now shows only 0.2.0). *Acceptance:* `npm view` shows 0.2.0 ×4 ✓; clean-dir
  `npm install pi-harnmem dsh-harnmem` auto-resolves `@harnmem/core@0.2.0`
  (no manual junction) and the pi entry imports ✓; `dsh plugin --profile
  npm-test add dsh-harnmem` installs 0.2.0 from npm ✓; all four READMEs now
  lead with npm install docs ✓.

- [x] **N8. Repository visibility and release notes.**
  Repository is public (2026-10-25) with the
  [`v0.2.0` release](https://github.com/ys118/harnmem/releases/tag/v0.2.0)
  published from the changelog. Discussions, secret scanning/push protection,
  private vulnerability reporting, master/tag rulesets and the CI badge are
  live; the pi-style contribution gate protects the issue tracker.

### Phase D — Claude Code adapter

- [x] **N9. Implement the Claude Code plugin `claude-harnmem`** (2026-10-26),
  shipped as a native plugin package instead of a bare `@harnmem/mcp` npm
  package: `.claude-plugin/plugin.json` + `hooks/` (SessionStart injection,
  SessionEnd detached extraction) + in-plugin stdio MCP server (5 tools) +
  `/harnmem:memory` command + repo-root marketplace manifest. `UserPromptSubmit`
  recall and `PreCompact` are intentionally not registered in v1 (compact
  re-fires `SessionStart(source=compact)`; per-turn injection breaks
  KV-caching). *Acceptance:* `claude plugin validate` ✓; real Claude Code
  2.1.310 session injects a seeded marker and the model reads it back ✓; the
  model stores a memory through `mcp__plugin_harnmem_harnmem__memory_write` and
  the record lands on disk ✓; `/harnmem:memory search` hits through the same
  store ✓; 8 deterministic adapter tests (`node --test
  packages/claude-harnmem/test/*.test.mjs`) ✓. Remaining for npm publish: bump
  to a release version and publish alongside `@harnmem/core`.

### Phase E — scale and quality (v0.3, when the store grows past ~5k)

- [ ] **N10. Index performance.** Persist shard indexes incrementally, load only
  hot shards at first query, shrink the index (front-coded terms / numeric
  arrays), add `harnmem doctor --rebuild-index`.
  *Targets:* 10k import < 3 s, first query p95 < 500 ms, index ≤ 1.5× the
  canonical `.md` store, all functional eval gates still PASS.
- [ ] **N11. Ranking calibration.** Improve P@1 on S8/S11 without losing
  R@10; use the A0–A5 ablation harness; consider field boosts / query-time
  synonym weighting before any reranker.

### Phase F — productization

- [ ] **N12. Operations:** `harnmem doctor` (integrity, orphan links, stale
  indexes, merge the `state/usage.json` overlay into frontmatter), backup and
  export/import for a single file, optional pre-commit hook.
- [ ] **N13. Extraction quality.** *(2026-10-23: first two parts landed —
  `audit.jsonl` now records `kind:"extract"` with status/reason/added/
  superseded/skipped/messages/userMessages, and `session.end` logs the same in
  `dsh.jsonl`.)* Remaining: decide the product default for `autoExtract` per
  harness and sample-audit extraction precision with the LLM-judge protocol in
  [`design/05-evaluation.md`](design/05-evaluation.md).
- [x] **N14. Documentation:** migration guide (dsh/pi/ZCode/Claude Code/Markdown →
  HarnMem), FAQ, adapter-authoring guide, refreshed README numbers.
  *Completed 2026-10-25.* Design of record:
  [`design/10-migration-onboarding.md`](design/10-migration-onboarding.md) — a
  three-layer onboarding path (relaxed JSON contract, `import md` / `import claude` /
  `import auto`, agent-assisted recipe). Shipped with it: user guide §8, the CLI
  README, [`faq.md`](faq.md), [`adapter-authoring.md`](adapter-authoring.md), a
  five-layer docs index and a refreshed [`README.md`](../README.md);
  `packages/cli/test/` covers the new import paths end to end.

### Phase G — Codex CLI adapter

- [x] **N15. Implement the Codex plugin `codex-harnmem`.** Research of record:
  [`research/codex-plugin.md`](research/codex-plugin.md) (2026-10-28, probe
  verified end-to-end on Codex desktop 26.1021 / CLI 0.164.0-alpha.11.1):
  one in-plugin stdio MCP server carries all four contract layers — the five
  canonical memory tools plus two internal hook tools; `SessionStart` runs as a
  `mcp_tool` hook whose tool return text is injected by Codex as a developer
  message (`hooks.additional_context`, probe-verified); `SessionEnd` spawns the
  detached extract worker from the same server (Codex hook timeouts are 1–3 s);
  the transcript parser reads Codex rollout JSONL
  (`~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`). Repo-root
  marketplace manifest `.agents/plugins/marketplace.json` (local source,
  ON_INSTALL). *Acceptance (all met 2026-10-28):* 9 deterministic tests green;
  real `codex exec` injected the seeded snapshot via
  `hooks.additional_context` (developer message) and the model answered from
  it (`PM=pnpm`), called `mcp__harnmem__memory_write` → `stored mem_… (NEW)`
  landed in the shared store with `source.harness="codex"` anchored to the
  real thread id; uninstall restored `config.toml` byte-identical. Known
  upstream limits recorded in the package README: Codex skips `SessionEnd`
  MCP hooks for now (declaration kept, warning harmless), unattended exec
  needs `--dangerously-bypass-hook-trust`, and MCP write tools need an
  approval mode that allows them.
- [ ] **N16. Post-install polish:** the desktop trust flow, the GitHub
  marketplace path, per-event hook verification, and the extraction gap are
  done (2026-10-29: trust persists in `config.toml [hooks.state]`; `exec`
  and the desktop app both run the SessionStart hook after trusting;
  `UserPromptSubmit` mcp_tool hooks verified via probe — supported but not
  used for injection, it would re-inject every turn; `SessionEnd` mcp_tool
  hooks remain unsupported upstream, so v0.2.0 backfills the previous
  session's rollout at every session start under a durable cursor,
  verified idempotent on the real store). Remaining: npm publish
  (`codex-harnmem` 0.2.0, awaiting user OTP).

## 5. Decision log

| Date | Decision | Why |
| --- | --- | --- |
| 2026-10-20 | Local-file SSOT (`~/.harnmem`), zero runtime deps in core/CLI, no embedding/services | Out-of-the-box, no middleware; reference projects showed file-native stores win on simplicity |
| 2026-10-20 | `ADD-only` writes + bi-temporal `SUPERSEDE`; never LLM-rewrite/delete memories | mem0 v3 dropped UPDATE/DELETE for information-loss reasons; history must survive |
| 2026-10-20 | English-only repository, MIT license, OSS scaffolding | Open-source release planned |
| 2026-10-20 | Adapter naming `<harness>-harnmem`; host-agnostic packages under `@harnmem/*` | Discoverability + ecosystem convention (`pi-memory`, `dsh-auto-memory`) |
| 2026-10-21 | DSH prompt section order 4050 (not 4000) | 4000 collides with `dsh-auto-memory`; deterministic composite prompt |
| 2026-10-21 | `toolPrefix` (default `memory_`, trial `harnmem_`) | pi silently keeps one of two duplicate tool names |
| 2026-10-23 | Likewise `dsh-harnmem` defaults to `toolPrefix: "harnmem_"` | Real DSH run: `dsh-auto-memory` owns `memory_write`/`memory_read`; the prefixed names are the only ones that can never be shadowed |
| 2026-10-23 | DSH adapter writes `~/.harnmem/logs/dsh.jsonl` and defaults `log: "on"` during the trial | The silent-write incident was undiagnosable: no file log, no skip reasons, no extraction audit events |
| 2026-10-23 | Dispose budget 20 s (was 8 s) and dispose handlers return their promise | Measured extraction 10.8–14.1 s on `deepseek-v4-flash`; the 8 s race closed the engine before every write. `session/disposed` is not awaited by the host and the unload path fails in ms, so shutdown still cannot hang |
| 2026-10-23 | Digest eviction drops the oldest **non-user** entry first | The 200-event ring evicted a session's first prompts before extraction, forcing `too_few_messages` |
| 2026-10-23 | Extraction LLM access uses a local chunk protocol bridge, not `@deepseek-ai/dsh-llm` imports | A `link:`-installed plugin resolves bare specifiers from its own directory; the failing dynamic import was swallowed as `status:"done", added:0` |
| 2026-10-23 | Coexistence policy: option (b) — trial keeps both plugins; after N4 disable `dsh-auto-memory`/`pi-memory` | Prefix + order 4050 fixed the functional collision, but two SSOTs drift and cost ~2.4 K injected tokens; single-store migration is the product direction |
| 2026-10-24 | Quit-time extraction becomes a **deferred catch-up at the next open of the same session** (`sessionEnd(reason:"resume_catchup")` after seeding the digest from the durable journal) | The host tears the provider adapters down before `plugin_unload`, so no LLM call can run at quit (`code:"NO_ADAPTER"` in ms); the journal survives and the desktop app resumes the last session on launch, so the memories land while the LLM is alive. Verified in the headless real runtime |
| 2026-10-24 | Cross-process extraction idempotency uses the `extract` audit events as a `messages` watermark, not the in-memory flag | The in-memory `extracted` flag dies with the process: a failed/partial extraction would either double-write after each restart or never cover newer turns. Only turns beyond the recorded count re-trigger; core skips `already_extracted` |
| 2026-10-24 | Extraction failures are visible: LLM errors bubble to `status:"failed"` and short digests skip as `digest_too_small` | `runExtraction` used to swallow both as an empty result, so a dead bridge logged `done added:0` — exactly the silence the trial is meant to remove |
| 2026-10-24 | Extraction budget 20 s → 60 s | Desktop-GUI catch-up of a 6,000-char digest on `<provider>/<model>` took 33.3 s and logged `extract.catchup {status:"failed", error:"extraction timed out after 20000ms"}`; the catch-up runs in the background and never blocks a turn, so a larger budget only helps, and a `failed` row does not advance the watermark so the next open retries |
| 2026-10-24 | Journal readers tolerate a leading UTF-8 BOM | PowerShell 5.1 `Set-Content -Encoding utf8` prepends a BOM; the first line was silently dropped, hydration lost one user prompt (5 entries/2 users instead of 6/3) and the catch-up gate did not fire |
| 2026-10-25 | Repository made public; `v0.2.0` GitHub release published from the changelog | Open-source flip completed after the prep PR (privacy sweep + history rewrite + contribution gate) was reviewed and merged |
| 2026-10-25 | Migration onboarding is three layers, not one parser per product: relaxed JSON contract, deterministic `md`/`claude`/`auto` importers, agent-assisted prompt for the long tail | The pipeline (dry-run, backup, ledger, verify/rollback) already exists; per-product connectors drift and multiply. Moving *conclusions* (title/description/content) rather than raw documents is what HarnMem injection rewards — design in [`design/10-migration-onboarding.md`](design/10-migration-onboarding.md) |
| 2026-10-25 | `import auto` probes only known harness memory stores; repository instruction files (`CLAUDE.md`, `AGENTS.md`, rule files) are never auto-migrated | Hosts inject instruction files directly, so importing them would double-inject and fork stale copies; explicit `import md --include-all` covers the decommissioning case |

### Trial notes (N1)

- **2026-10-23 21:33 — desktop GUI, real `~/.harnmem`.** After restarting the
  bundled app, `logs/dsh.jsonl` shows `plugin.apply` with the trial defaults
  (`toolPrefix:"harnmem_"`, `log:"on"`, `llmTimeoutMs:20000`),
  `tools.registered {count:5, of:5, prefix:"harnmem_"}` and `session.started`
  (`bytes:301`, `ids:1`, the pi-written pnpm preference). One `harnmem_write`
  stored a project memory and refreshed the live snapshot (457 B / 104 tokens /
  2 ids), with the matching `write` event in `audit.jsonl`. **Quit path:** the
  21:33:15 quit appended all 13 open session transcripts at once
  (`sessions/20261023/*.jsonl`, mtime `13:33:15.16–.20Z`; this session's 200-line
  transcript included) — dispose ran — but `dsh.jsonl` recorded no
  `session.end` and `audit.jsonl` no `"kind":"extract"`, so extraction never
  completed before the host exited. The 21:52:46 restart left no dispose trace
  at all (hard quit). Remaining product gap: quit-time extraction; candidate
  mitigations for N13 — turn/idle-triggered extraction, resumable
  pending-extraction on next boot, or a documented limitation.
- **2026-10-23 — disposable ACP profile** (installed DSH 0.2.1-rc.2): 3 user
  turns → `session.end status=done added:3`; next session injected
  719 B / 170 tokens; three memory files written.
- **2026-10-24 — headless real runtime, quit-path fix.** Scratch home
  (`.tmp/n2-catchup-home`), profile `harnmem-verify` (`dsh-base` + `headless` +
  the linked adapter), journal seeded with 6 entries / 3 long user messages.
  One real run: `digest.hydrated {entries:6, userMessages:3}` →
  `extract.catchup {status:"done", added:1}` (LLM `deepseek-flash`, 4.2 s,
  778 chars + 1,377 reasoning chars) → `audit.jsonl` `extract added:1` →
  memory `<memory-id>` written; the dispose that followed logged
  `session.end status:"skipped" skipReason:"already_extracted"`. The preceding
  run (journal seeded with a BOM) reproduced the old failure: hydration lost one
  prompt (5/2), no catch-up, `llm.callFailed code:"NO_ADAPTER"` at unload.
- **2026-10-24 11:18 — real `~/.harnmem`, resume catch-up end-to-end.**
  Headless profile `harnmem-verify` against the real store: created a session,
  appended three preference turns to its journal (simulating the prompts the old
  code never journaled), then resumed with `--session-id`. Logs:
  `digest.hydrated {entries:10, userMessages:4}` → `llm.response
  {chars:1812, reasoningChars:2037, finish:"stop"}` after 6.6 s →
  `extract.catchup {status:"done", added:4}` → `session.end
  {status:"skipped", skipReason:"already_extracted"}`. `audit.jsonl` shows four
  `write` events and `extract done added:4 messages:10 userMessages:4`, then the
  `already_extracted` skip. Four memory files appeared (3 project, 1 user;
  store now user 2 / project 5). A preceding run with a too-short turn exited
  before the background LLM call returned and logged no `extract.catchup` — the
  headless CLI does not keep the process alive for it; the desktop app process
  persists, so this is CLI-only.
  *Desktop note:* the currently resumed tabs have only 0–1 user messages in
  their journals (one has 1, the other 0), so a plain restart will hydrate
  below `minUserMessages`; to watch catch-up in the GUI, open a session whose
  journal has ≥3 users (two candidate sessions have four each) or accumulate
  three prompts before quitting.

- **2026-10-24 11:23 — desktop GUI restarted onto the catch-up build.** The
  quit of the old instance (11:22:52) logged five `session.end` lines (dispose
  ran; all `too_few_messages`) — the quit moment itself still cannot call a
  model, as designed. On launch the app hydrated and started the catch-up:
  `digest.hydrated {entries:200, userMessages:3}` for this session (the 200-event
  digest of the quit plus today's prompts, including the user-preserving
  eviction) and `llm.call` fired immediately. The call took
  33.3 s on `<provider>/<model>` (1,645 chars + 5,582 reasoning
  chars) and crossed the 20 s budget, so it logged `extract.catchup
  {status:"failed", error:"extraction timed out after 20000ms"}` — visible, not a
  silent `done added:0` — and the watermark stayed put, so the next open retries.
  A small session (12 entries / 5 users) finished in 14.3 s:
  `extract.catchup {status:"done", added:1}`, the first desktop-GUI catch-up
  write. Follow-up landed: after the restart with the 60 s build
  (`plugin.apply llmTimeoutMs:60000`), the same session retried on open —
  `digest.hydrated {entries:200, userMessages:4}` → `llm.response
  {chars:2598, reasoningChars:3453, finish:"stop"}` after 37.3 s →
  `extract.catchup {status:"done", added:3}`; `audit.jsonl` gained three `write`
  events and `extract done added:3 messages:200 userMessages:4`, and three
  memory files appeared (titles: "raise the DSH catch-up extraction budget
  from 20 s to 60 s", "desktop catch-up verified: small sessions succeed,
  large sessions hit the 20 s timeout", "catch-up failures must be reported
  explicitly and must not advance the watermark").

- **2026-10-25 — N1 wrap-up: trial closed, verdict useful.** Trial window
  2026-10-21 → 10-25 on the real `~/.harnmem`, pi and the DSH desktop app in
  daily use; single store since 10-24. Numbers at close:
  - Injections: 150 audit `inject` events (130 `session_start`, 4 `resume`,
    16 write-refreshes); dsh 88 / pi 62. Average injection grew from 301 B
    (1 id) before the migration to 3.2–5.5 KB (avg 13–23 ids, roughly
    0.8–1.3K tokens) after it — inside `injectMaxTokens: 1200`; ≈0.46 MB
    injected over the whole trial.
  - Captures: 32 `write` events (28 NEW incl. supersedes, 3 LINK, 1 MERGE);
    28 record files created since 10-24 across user scope and 4 projects.
    All write paths fired: desktop catch-up extraction +8 (two sessions,
    +4/+1 and +3), explicit model tool calls (pi 8 NEW + 1 LINK, dsh
    10 NEW + 2 LINK), CLI 3 NEW.
  - Extraction: 60 `extract` events — 3 done (+8 records), 4 failed, 50
    skipped (`too_few_messages` 35, `already_extracted` 8, `model_wrote` 3,
    `read_only` 4). Every failure was visible, never a silent `done added:0`:
    1×20 s timeout (old build; retried successfully on reopen), 3×
    `NO_ADAPTER` at quit dispose (expected; watermark not advanced). Two
    sessions (4 and 10 user messages) still await
    their catch-up on next open — concrete N13 examples of the
    never-reopened gap.
  - Recall in real use: pi `harnmem_search` ×5 with real queries (cf CLI
    environment, Node toolchain, <project-c> quota, pi extensions) plus
    `harnmem_read` ×2; the DSH read-only memory browser served 7 process
    runs; injected snapshots demonstrably reused cross-project (later
    sessions recalled the pnpm/commit-style/toolchain memories instead of
    re-deriving them).
  - Health at close: `harnmem stats` — 70 records / 62 active, 0 duplicate
    candidates, 0 orphans, `extract pending 0, failed 0`; pi 1.4.0 (10-25)
    loads the adapter fine with the root-entry fix (`2e78bc3`).
  - Residuals (not N1 blockers): one cross-scope duplicate family
    ("Node/npm toolchain baseline" ×3 across user+project — dedupe is per-scope
    by design); <project-a> carries two project identities (`<project-id>`
    23 records vs `<project-id>` 3) — the known path-key/git-key split. Both
    are N12 doctor/normalize fodder.

### Post-migration cleanup (2026-10-25)

- Full re-audit of both migrations passed: dsh-auto-memory 30/30 (ledger
  `mig-20261024T035400Z-xu092w.json`, idempotent re-run 30 skipped) and
  pi-memory 10/10 (`mig-20261024T035400Z-ek35re.json`, re-run 10 skipped);
  all 40 migrated ids verified live in `~/.harnmem/memories`, none in `trash/`.
- Gap found and closed: `daily/2026-10-17.md` (a session with lesson-2
  delivery stats) had no `imports/unresolved` record; appended as a third
  record into `unresolved/<session-id>/records.json` (count 2 -> 3, JSON validated).
- User decision: **HarnMem is the single source of truth (SSOT) for all memory
  across harnesses.** Legacy stores deleted after byte-level backup
  verification: `~/.pi/agent/memory/` (14 files; backup =
  `state/backups/mig-20261024T035400Z-ek35re/source/`, byte-identical);
  `~/.dsh/memory/` was already removed on 2026-10-24 (backup =
  `state/backups/mig-20261024T035400Z-xu092w/source/`).
- Config residue removed: `dsh-auto-memory@0.9.0` entry dropped from
  `~/.dsh/profiles/desktop/pnpm-workspace.yaml` `minimumReleaseAgeExclude`
  (node_modules and pnpm-lock verified clean). The provenance comment in
  `cordis.patch.yml` L112-114 is intentionally kept.

## 6. Verification runbook

```powershell
# from <repo>
pnpm -r build
pnpm -r typecheck
pnpm test                                   # core 52/52
node --test packages/dsh-harnmem/test/*.test.mjs   # adapter 58/58
node evals/gen/generate.mjs --check         # 36 files byte-identical
node evals/run.mjs --engine core --gate     # functional PASS; 5 advisory

# store inspection
node packages/cli/dist/main.js stats
node packages/cli/dist/main.js search "some query" --json
Get-Content $HOME\.harnmem\state\audit.jsonl -Tail 5
Get-Content $HOME\.harnmem\logs\dsh.jsonl -Tail 20
```

**Guardrails when continuing** (do not regress):

- Keep `@harnmem/core` and `@harnmem/cli` free of runtime dependencies.
- Keep the injected snapshot byte-stable within a session (no timestamps in
  per-turn text); rebuild only on session start / compaction / write / day
  rollover.
- Never auto-delete memories; forget = `trash/` (30-day grace), `--hard` only
  on explicit request.
- Repository text stays English; CJK is allowed only as data/fixtures.
- Any change to scoring, tokenization or budgets must rerun
  `node evals/run.mjs --engine core --gate` and update `design/03`, `design/05`
  and `evals/results/eval-report.md` together.

## 7. Resume prompt for an agent

> Read `docs/ROADMAP.md`, then pick the first unchecked item (N1…). Implement it,
> run the verification runbook, update this file and `CHANGELOG.md`, and commit.
> Do not change public behavior outside the item's scope. If a decision is
> needed, ask first.

## 8. Links

- [Implementation plan](design/06-implementation-plan.md) — engineering milestones
- [Evaluation](design/05-evaluation.md) and `evals/README.md` — how the numbers are produced
- [User guide](user-guide.md) — install and day-to-day use
- [Adapter contract](design/07-adapter-contract.md) — what a new harness adapter must provide
