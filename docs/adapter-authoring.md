# Adapter authoring guide

There are two different "adapters" in this repository. Pick the track that matches
what you want to build:

| Track | Goal | Where it lives | Contract |
|---|---|---|---|
| **A. Importer** | Bring an existing memory store *into* HarnMem | `packages/cli/src/importers/*.ts` | [`design/10-migration-onboarding.md`](design/10-migration-onboarding.md) §3, §11 |
| **B. Runtime adapter** | Make a harness *use* HarnMem for injection, tools and extraction | `packages/<harness>-harnmem/` | [`design/07-adapter-contract.md`](design/07-adapter-contract.md) |

Both are thin: the engine owns storage, retrieval, writing and lifecycle; adapters
only translate. Do not reimplement retrieval or storage logic in either track.

## Track A: import a legacy store into HarnMem

The shared pipeline (`packages/cli/src/pipeline.ts`) already gives you dry-run
planning, source backup + sha256 manifest, ledger idempotency, verify and
per-run rollback. All you add is a **discovery function** and its wiring.

### The discovery contract

```ts
// packages/cli/src/importers/types.ts
interface DiscoverOptions {
  sourcePath: string;          // --path (or the per-source default)
  sessionsRoot?: string;       // session logs, when the store needs cwd recovery
  pathMap: Record<string, string>;
  fallbackProject?: string;    // --project, already resolved to a project id
  cwd: string;                 // where the command was run
  home: string;                // <home>/projects.json registry
  includeDaily: boolean;
  // optional flags added for specific sources:
  sourceLabel?: string; jsonl?: boolean; mdMode?: "file" | "heading";
  maxFiles?: number; includeAll?: boolean;
}

interface DiscoverResult {
  harness: string;                 // ledger/label, e.g. "claude"
  sourceRoot: string;              // the directory/file that was read (read-only)
  items: ImportItem[];             // importable records
  unresolved: UnresolvedGroup[];   // valid records that cannot be attributed
  counts: DiscoverCounts;          // files, entries, skipped (+ dailyEntries?)
  warnings: string[];              // shown by dry-run and in the report
}

interface ImportItem {
  key: string;        // makeKey(harness, relativeOriginPath, originalId)
  sourceHash: string; // hashRecord(record) — stable across runs
  originPath: string; // absolute path (or file/entry anchor) for the ledger
  record: ImportRecord;
  note?: string;
}
```

Rules the pipeline relies on:

1. **Discovery is pure and read-only.** No writes to the source, no network, no
   clock-dependent ids (`sourceHash` must not change on a re-run). `runImport`
   does the backup, the writes and the ledger.
2. **One record = one conclusion** (rule, decision, preference, pitfall, stable
   fact), not a copied document. Use `MAX_TITLE_CHARS` (80),
   `MAX_DESCRIPTION_CHARS` (200), `MAX_CONTENT_CHARS` (60 000) and the `truncate`
   helper.
3. **Never silently drop.** An unparseable/empty file is `counts.skipped`; a
   record that parses but cannot be attributed goes to `unresolved` with a
   readable `reason`. Downgrading a project-scoped record to `user` requires a
   warning (see `md.ts`).
4. **Deterministic ordering.** Sort files and records; ids and keys must be
   stable so the second run imports 0.
5. **Idempotency key**: `makeKey(harness, relativeOriginPath, originalId)`, where
   `originalId` is the store's own id or a stable anchor (`file:<rel>`,
   `heading:<rel>#<slug>`, frontmatter name, block hash).
6. **Source hash**: `hashRecord(record)` — it hashes without `source`, so a
   timestamp that defaults to `Date.now()` cannot fake a changed source.

### Steps

1. **Write the importer** `packages/cli/src/importers/<source>.ts` exporting
   `discover<Source>(options: DiscoverOptions): Promise<DiscoverResult>`.
   Reuse the shared helpers from `importers/types.ts` (`makeKey`, `hashRecord`,
   `declaredType`, `typeFromLegacyTags`, `parseLegacyTimestamp`, `asScope`,
   `truncate`, `collapseWhitespace`, `extractHashtags`, `extractWikiLinks`) and
   `frontmatter.ts` (`parseFrontmatter`, `fmString`, `fmNestedString`).
2. **Attribute projects** with `attributeProject` from
   `packages/cli/src/project-resolve.ts`:

   ```ts
   const attribution = await attributeProject({
     keys: [dirName, dirPath],       // path-map keys and evidence
     pathMap: options.pathMap,
     home: options.home,
     cwd: options.cwd,
     harness: "your-harness",        // HarnessId accepts custom ids
     sessionCwd,                     // optional: recovered from session logs
     fallback: options.fallbackProject,
   });
   ```

   The chain is `--path-map` → recovered session cwd → decoded/guessed path →
   `--project`; anything else must become an `unresolved` group.
3. **Register the source** (five places):
   - `packages/cli/src/pipeline.ts`: extend `type ImportSource`, add the
     `discoverSources` switch case, pass any new options through `DiscoverOptions`.
   - `packages/cli/src/commands.ts`: add it to `IMPORT_SOURCES` (the subcommand
     list and help derive from it), `defaultSourcePath`, `resolveSourcePath`
     (throw `UsageError` when `--path` is required), and the `cmdImport` switch.
   - `packages/cli/src/main.ts`: declare any new flags in `COMMAND_FLAGS.import`.
   - `packages/cli/src/importers/types.ts`: only if the source needs new options.
   - Help text in `cmdImportHelp` (commands.ts).
4. **Test it** in `packages/cli/test/import-<source>.test.mjs` with the helpers
   `isolatedStores`, `runCliJson`, `runCli`, `countMemories`, `readMemoryBodies`,
   `write`. Cover, at minimum:
   - dry-run counts, `byType`, `unresolvedKeys`, and that nothing was written;
   - `--apply --verify`: ids present, manifest `sourcesUnchanged`;
   - second run: 0 imported, N skipped (idempotency);
   - `import rollback <runId>`: store returns to the pre-import count;
   - the interesting edge of your format (decoded directory names, session cwd,
     corrupt line, host instruction file, …).
5. **Document it**: user guide §8 (one line + verified results), CLI README
   Migration section, `CHANGELOG.md` (keep it to one bullet), and mark the status
   in `design/10-migration-onboarding.md` §11. Then run:

   ```bash
   pnpm --filter @harnmem/cli build
   node --test packages/cli/test/*.test.mjs
   pnpm -r build && pnpm -r typecheck && pnpm test
   ```

### Worked examples

| Example | Shows |
|---|---|
| `importers/json.ts` | The universal contract: envelopes, JSONL, aliases, per-record unresolved |
| `importers/md.ts` | Tree walker, frontmatter mapping, heading splitting, git-root attribution |
| `importers/zcode.ts` | Directory-encoded project names and `.md` trees |
| `importers/claude.ts` | Project attribution recovered from session JSONL (`readClaudeSessionCwds`) |
| `importers/dsh.ts` / `importers/pi.ts` | MEMORY.md block formats and session-cwd recovery |

### Importer checklist

- [ ] Discovery writes nothing; `--apply` alone mutates HarnMem
- [ ] Second run imports 0 for an unchanged source
- [ ] Unattributable records land in `unresolved` with a reason, never a silent `user` scope
- [ ] `import verify` reports `sources unchanged`
- [ ] `import rollback` restores the previous memory count
- [ ] Fixtures are synthetic (no real personal memory content, no network)
- [ ] Help text, README, user guide and CHANGELOG updated

## Track B: make a harness use HarnMem

Read [`design/07-adapter-contract.md`](design/07-adapter-contract.md) first; it is
the normative contract. The engine facade (`@harnmem/core`, API version
`HARNMEM_API_VERSION = 1`) is the only dependency:

```ts
const eng = await HarnMem.open({
  home, harness: "your-harness", sessionId, cwd, project,
  llm,              // adapter-provided callback; null → extraction degrades to no_llm
  readOnly,         // subagents / read-only sessions
  budget: { injectTokens },
  write: { autoExtract },
  log: (level, msg, data) => harnessLog(level, msg, data),
});
```

### The four layers

| Layer | What to implement | Degrade to |
|---|---|---|
| Injection | Put `eng.ensureContext()` text into the system prompt / hook `additionalContext` at session start | Keep the session running, audit the failure |
| Tools | `memory_write`, `memory_search`, `memory_read`, `memory_forget`, `memory_status` (+ optional restore/consolidate/pin) | Injection-only mode |
| Lifecycle | Session start/resume (open engine, inject), compaction (re-inject), memory writes (mark context dirty), session end (`sessionEnd()` → bounded extraction), `close()` | Audited extraction failure, never a blocked exit |
| Config | Map harness config + env (`HARNMEM_HOME`, `HARNMEM_DISABLED`, `HARNMEM_READONLY`) into `HarnMemConfig` | Built-in defaults; precedence in 07 §7 |

### Hard rules

- **Injection must be byte-stable.** Cache the `ensureContext()` snapshot and
  rebuild it only on session start/resume, compaction, a memory write, or day
  rollover. Two turns without writes must inject identical bytes, or the
  harness's KV cache is invalidated every turn
  ([`design/03-retrieval.md`](design/03-retrieval.md)).
- **The engine is the enforcement surface.** Tool schemas are hints; never rely
  on them to reject invalid values (07 §3.6). Pass raw input to the engine and
  surface its warnings.
- **Never write to stdout.** Use the engine's `log` callback; stdout corrupts TUI
  or JSON channels.
- **Bound extraction.** `sessionEnd()` must be time-boxed, never block exit, and
  be skipped for subagents/read-only sessions. The model write tools keep working
  when `llm` is null.
- **Adapters contain no retrieval/storage logic.** If it is not injection, tool
  wiring, lifecycle or config mapping, it belongs in core.

### Packaging and tests

- Package name: `<harness>-harnmem` (e.g. `pi-harnmem`, `dsh-harnmem`,
  `opencode-harnmem`). Harness-neutral packages take the `@harnmem` scope.
  `@harnmem/core` and `@harnmem/cli` must stay runtime-dependency-free; adapter
  packages may keep the harness SDK as a `peerDependency`.
- Tests must be deterministic: a fake harness/fixture instead of a live session.
  Reference: `packages/dsh-harnmem/test/` (including `fake-dsh.mjs`) and
  `packages/pi-harnmem`.
- Ship a README with install steps and one end-to-end verification note (what to
  do, what to observe). A non-obvious harness gets a design doc under
  `docs/design/` with a status line; `08-dsh-adapter.md` and
  `09-claude-adapter.md` are two worked examples (in-process plugin and MCP
  stdio + hooks).

### Runtime adapter checklist (from 07 §8)

- [ ] Empty store injects 0 bytes without errors
- [ ] A memory written now is visible in a new session's injection (test once
      cross-session, once cross-harness)
- [ ] `memory_search` finds a Chinese query (bigram tokenization works)
- [ ] Two turns in one session inject identical bytes (cache stability)
- [ ] Session exit does not hang (extraction timeout protection)
- [ ] Read-only mode works with no LLM and no write permission
- [ ] Subagents/child sessions do not write duplicates
- [ ] After migrating old memories, the old data is searchable and not duplicated

## Getting it merged

Read [CONTRIBUTING.md](../CONTRIBUTING.md): open an issue first (the contribution
gate auto-closes new contributors' items for batch review), keep one concern per
PR, run `pnpm -r build`, `pnpm -r typecheck` and `pnpm test` (plus
`pnpm --filter dsh-harnmem test` if you touched that adapter), and keep repository
text English.
