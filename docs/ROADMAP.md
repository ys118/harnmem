# Roadmap and current status

Single source of truth for **where the project stands and what to do next**.
Design intent lives in [`design/`](design/); this file tracks execution state.

Last updated: **2026-10-23** (after the first real-trial period).

## 1. Snapshot

| Item | State |
| --- | --- |
| Repository | `github.com/ys118/harnmem` (private), branch `master`, CI green at `0256a1e` |
| Latest release | `v0.1.0` tag on `3203871` (pi-first release; **predates** the DSH adapter) |
| Commits after `v0.1.0` | `54ff3e4`, `81cec2b`, `4d23ec2`, `539e56a` (DSH adapter + cold-start fix), `0256a1e` (coexistence fixes) |
| Packages (all `0.1.0`, unpublished) | `@harnmem/core`, `@harnmem/cli`, `pi-harnmem`, `dsh-harnmem` |
| Core tests | 22/22 pass (`pnpm test`) |
| Evaluation | functional gates PASS; macro R@10 1.000, MRR 0.891, nDCG@10 0.911; 5 advisory perf gates (see §3) |
| Real trial | running since 2026-10-21: pi (with `pi-memory`) and DSH desktop (with `dsh-auto-memory`) both installed side by side |
| Environment | Windows 11, Node 24.9.0, pnpm 10.33.2, pi 1.3.0, DeepSeek Harness 0.2.1-rc.2 |

**Live trial evidence** (`C:\Users\<user>\.harnmem`):

- 1 real memory captured (`<memory-id>`, user feedback: "prefers pnpm"),
  written through the pi adapter's `harnmem_write`.
- 27 audited events: 26 injection events (13 `dsh` + 13 `pi`: 25 `session_start`,
  1 `resume`) plus 1 write. Both adapters inject byte-stable snapshots at
  session start.
- No writes or extraction failures observed in either harness; `extract pending 0, failed 0`.
- Open question: the trial has produced **no auto-extracted memories yet** — see N2.

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
  `llmTimeoutMs: 20000`, `log: "on"` during the trial, `toolPrefix: "harnmem_"`.
  The five tools are therefore `harnmem_write/search/read/forget/status`; the
  bare `memory_write`/`memory_read` names belong to `dsh-auto-memory` (the first
  registrant wins in DSH, N2 incidentally proved that with tools 3/5 only).
- Logs: `~/.harnmem/logs/dsh.jsonl` (JSON lines; `log: "errors"` is the quieter
  setting, `HARNMEM_LOG` overrides). It records `plugin.apply`,
  `session.created`, `session.end` (status/added/skipReason/digest size),
  `session.endTimeout`, and the extraction LLM bridge (`llm.call`,
  `llm.response`, `llm.callFailed`).
- `llmTimeoutMs: 20000` bounds the dispose race. A real extraction (3 memories,
  ~2.1 KB JSON) measured 10.8–14.1 s on `deepseek-v4-flash` (reasoning tokens
  included), so the old 8 s budget cut **every** real extraction off — the
  timeout was one of the reasons desktop never wrote a memory (N2,
  2026-10-23). At process unload the provider adapters are already gone, so the
  call fails in milliseconds and shutdown does not hang.
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
   preservation, 20 s dispose budget, local LLM protocol bridge, awaited
   dispose). **Remaining:** repeat once in the desktop GUI profile during N1;
   decide the product default for `autoExtract` in N13.
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
   each). Decide the target configuration in N3.
6. **pi adapter default `autoExtract: false`** vs DSH adapter default `true` —
   intentional in the trial, but the product default should be decided in N13.
7. **ZCode importer is unverified** (no `~/.zcode` data on this machine);
   `unresolved` buckets are handled but have no real fixture.
8. **npm release workflow fails by design** (`ENEEDAUTH`) until `NPM_TOKEN` and
   the `@harnmem` scope exist; provenance signing also requires a public repo.
9. **Dependabot `npm_and_yarn` job fails** on workspace `link:` dependencies —
   harmless; ignore or disable that ecosystem in `.github/dependabot.yml`.
10. **Claude Code adapter** is design-only ([`design/09-claude-adapter.md`](design/09-claude-adapter.md)).

## 4. Next steps

Work top-down. Each item is self-contained: goal → actions → acceptance.
Check boxes as items land, and update this file when the status changes.

### Phase A — finish the real trial (decision gate)

- [ ] **N1. Run the trial for a few more real sessions.**
  Use pi and DSH normally for 2–3 days (both plugins on). Look at:
  ```powershell
  node packages/cli/dist/main.js stats --home C:\Users\<user>\.harnmem
  Get-Content C:\Users\<user>\.harnmem\state\audit.jsonl -Tail 20
  Get-Content C:\Users\<user>\.harnmem\logs\pi.jsonl -Tail 20
  ```
  Record: injection bytes per session (audit `bytes`), token overhead, whether
  any memory was captured and whether any recall was actually useful.
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
  user-prompt-preserving digest eviction, 20 s dispose budget, local LLM
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

- [ ] **N3. Decide the coexistence policy.**
  Options: (a) keep both memory plugins long-term (redundant tokens, safest
  migration), (b) migrate legacy memories, then disable `dsh-auto-memory` and
  `pi-memory` and use HarnMem alone, (c) keep them for harness-specific
  behavior and disable HarnMem injection per harness.
  *Recommendation:* (b) after N4, because two SSOTs drift. Write the decision
  here and apply the config changes.

### Phase B — one store, real data

- [ ] **N4. Migrate the existing legacy stores into `~/.harnmem`.**
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

- [ ] **N5. Validate the merged store.**
  Run `harnmem stats`, a handful of real queries per project, check scopes
  (user vs project) and duplicates; add a `tagmap.json` only if the pi tag
  vocabulary needs mapping.
  *Acceptance:* no cross-project leaks, no duplicate candidates, search results
  judged useful by hand.

### Phase C — release v0.2.0

- [ ] **N6. Bump and tag.**
  Version `0.2.0` in all four packages, `CHANGELOG.md` entry ("DSH adapter,
  cold-start injection, toolPrefix coexistence, section order"), commit, push,
  tag `v0.2.0`, confirm CI and the release workflow (publish still expected to
  fail without npm credentials).
  *Acceptance:* tag on a green commit; `git log v0.1.0..v0.2.0` tells the story.

- [ ] **N7. Publish to npm (publish order matters).**
  ```powershell
  pnpm -r build
  pnpm --filter @harnmem/core publish --access public --no-git-checks
  pnpm --filter @harnmem/cli publish --access public --no-git-checks
  pnpm --filter pi-harnmem publish --access public --no-git-checks
  pnpm --filter dsh-harnmem publish --access public --no-git-checks
  ```
  Requires: npm account + 2FA, free org `harnmem`, and for CI publishing an
  Automation token stored as `NPM_TOKEN`. Provenance (`--provenance`) requires
  a public repo.
  *Acceptance:* `npm view` shows 0.2.0; `pi install npm:pi-harnmem` works in a
  clean profile; `dsh plugin --profile <p> add dsh-harnmem` works without a
  manual core junction; document both in the package READMEs.

- [ ] **N8. Repository visibility and release notes.**
  Decide public vs private (public unlocks provenance, issues, stars);
  add a GitHub release for `v0.2.0` from the changelog; only then add badges
  that point at CI.

### Phase D — Claude Code adapter

- [ ] **N9. Implement `@harnmem/mcp` + hooks** per
  [`design/09-claude-adapter.md`](design/09-claude-adapter.md):
  zero-dependency stdio JSON-RPC MCP server exposing the 5 tools, plus
  `SessionStart` (`additionalContext`, ≤10 KB, byte-stable), `UserPromptSubmit`,
  `SessionEnd` (bounded extraction), `PreCompact` hooks.
  *Acceptance:* `claude mcp add --transport stdio harnmem -- …` works; a real
  Claude Code session writes and recalls; adapter tests; docs + npm publish.

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
- [ ] **N14. Documentation:** migration guide (dsh/pi/ZCode → HarnMem),
  FAQ, adapter-authoring guide, refreshed README numbers.

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
| — | **Pending:** npm publishing, repo visibility, coexistence policy (N3), Claude adapter timing | Need user decision / release step |

## 6. Verification runbook

```powershell
# from <repo>
pnpm -r build
pnpm -r typecheck
pnpm test                                   # core 22/22
node --test packages/dsh-harnmem/test/*.test.mjs   # adapter 25/25
node evals/gen/generate.mjs --check         # 36 files byte-identical
node evals/run.mjs --engine core --gate     # functional PASS; 5 advisory

# store inspection
node packages/cli/dist/main.js stats
node packages/cli/dist/main.js search "some query" --json
Get-Content C:\Users\<user>\.harnmem\state\audit.jsonl -Tail 5
Get-Content C:\Users\<user>\.harnmem\logs\dsh.jsonl -Tail 20
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
