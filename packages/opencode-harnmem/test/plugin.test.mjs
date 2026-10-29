import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const plugin = await import(pathToFileURL(path.join(pkgRoot, "index.js")).href);
const { pluginVersionMajor, capBytes, toCoreMessages, normalizeArgs, createPluginState } = plugin;
const { resolveSettings } = await import(pathToFileURL(path.join(pkgRoot, "lib", "settings.mjs")).href);

test("resolveSettings expands a leading ~ instead of resolving it under cwd", () => {
  const cwd = process.cwd();
  assert.equal(resolveSettings(cwd, { HARNMEM_HOME: "~/harnmem-test" }).home, path.join(os.homedir(), "harnmem-test"));
  assert.equal(resolveSettings(cwd, { HARNMEM_HOME: "~/.harnmem" }).home, path.join(os.homedir(), ".harnmem"));
  assert.equal(resolveSettings(cwd, { HARNMEM_HOME: "~" }).home, os.homedir());
  assert.equal(resolveSettings(cwd, { HARNMEM_HOME: "D:\\store" }).home, path.resolve("D:\\store"));
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("pluginVersionMajor parses opencode version strings", () => {
  assert.equal(pluginVersionMajor("2.1.4"), 2);
  assert.equal(pluginVersionMajor("2.0.0-dev"), 2);
  assert.equal(pluginVersionMajor("1.19.5"), 1);
  assert.equal(pluginVersionMajor(""), null);
  assert.equal(pluginVersionMajor(undefined), null);
  assert.equal(pluginVersionMajor("nonsense"), null);
});

test("capBytes is a no-op under the cap and truncates on line boundaries", () => {
  const small = "hello\nworld";
  assert.equal(capBytes(small, 1000), small);
  const big = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(80)}`).join("\n");
  const capped = capBytes(big, 2_000);
  assert.ok(Buffer.byteLength(capped, "utf8") <= 2_000, "must respect the byte cap");
  assert.ok(capped.endsWith("injection cap -->"), "must carry the truncation marker");
});

test("toCoreMessages maps opencode session.context shapes and skips junk", () => {
  const raw = [
    { id: "m1", type: "user", text: "first question", time: { created: 1_700_000_000_000 } },
    {
      id: "m2",
      type: "assistant",
      text: "",
      content: [
        { type: "reasoning", text: "hidden chain of thought" },
        { type: "text", text: "answer part one" },
        { type: "text", text: "answer part two" },
      ],
      time: { created: "2026-10-28T12:00:00.000Z" },
    },
    { type: "step-start" }, // unknown shape: skipped
    { type: "user", text: "   " }, // blank: skipped
    null, // junk: skipped
  ];
  const out = toCoreMessages(raw);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { role: "user", text: "first question", ts: 1_700_000_000_000 });
  assert.equal(out[1].role, "assistant");
  assert.equal(out[1].text, "answer part one\nanswer part two");
  assert.equal(out[1].ts, Date.parse("2026-10-28T12:00:00.000Z"));
  assert.deepEqual(toCoreMessages(undefined), []);
  assert.deepEqual(toCoreMessages("nope"), []);
});

test("toCoreMessages truncates long texts and keeps the 400-message tail", () => {
  const long = toCoreMessages([{ type: "user", text: "y".repeat(5_000) }]);
  assert.equal(long[0].text.length, 4_000);
  const many = Array.from({ length: 500 }, (_, i) => ({ type: "user", text: `msg-${i}` }));
  const tail = toCoreMessages(many);
  assert.equal(tail.length, 400);
  assert.equal(tail[0].text, "msg-100");
  assert.equal(tail[399].text, "msg-499");
});

test("normalizeArgs maps bare values onto the single required key", () => {
  assert.deepEqual(normalizeArgs({ query: "x" }, "query"), { query: "x" });
  assert.deepEqual(normalizeArgs("x", "query"), { query: "x" });
  assert.deepEqual(normalizeArgs(42, "id"), { id: 42 });
  assert.deepEqual(normalizeArgs(null, "id"), {});
  assert.deepEqual(normalizeArgs(undefined), {});
  assert.deepEqual(normalizeArgs(["a", "b"], "query"), {}); // arrays are junk: no wrap
});

// ---------------------------------------------------------------------------
// createPluginState wiring (ctx mocked with the probed domain shapes)
// ---------------------------------------------------------------------------

function mockCtx({ version = "2.1.4", directory = "D:\\mock\\proj", sessionRecord, transcript } = {}) {
  const hooks = new Map();
  const tools = [];
  return {
    ctx: {
      app: { name: "opencode", version, channel: "stable" },
      location: { directory, workspaceID: "w1", project: "p1" },
      session: {
        hook: async (name, cb) => {
          hooks.set(name, cb);
          return { dispose: () => hooks.delete(name) };
        },
        get: async ({ sessionID }) =>
          sessionRecord ?? { id: sessionID, projectID: "p1", location: { directory, workspaceID: "w1" } },
        context: async ({ sessionID }) =>
          transcript ?? [
            { id: "m1", type: "user", text: `hello from ${sessionID}`, time: { created: 1 } },
            { id: "m2", type: "assistant", text: "done", time: { created: 2 } },
          ],
      },
      tool: {
        transform: async (fn) => {
          const reg = { add: (spec) => tools.push(spec) };
          await fn(reg);
          return { dispose: () => {} };
        },
      },
    },
    hooks,
    tools,
  };
}

function mockEngine() {
  const calls = [];
  return {
    calls,
    async sessionStart(input) {
      calls.push(["sessionStart", input]);
      return { text: "HarnMem memory (cross-harness; stable snapshot)\n- mem_1 test", ids: ["mem_1"] };
    },
    async sessionEnd(input) {
      calls.push(["sessionEnd", input]);
      // Matches what current core actually returns with autoExtract off.
      return { status: "skipped", skipReason: "auto_extract_off", added: [] };
    },
    async write(input) {
      calls.push(["write", input]);
      return { action: "NEW", id: "mem_new", warnings: [] };
    },
    async search(input) {
      calls.push(["search", input]);
      return { query: input.query, results: [], total: 0, abstained: true };
    },
    async read() {
      calls.push(["read"]);
      return null;
    },
    async forget(id, opts) {
      calls.push(["forget", id, opts]);
      return { ok: true, id, mode: opts?.hard ? "hard" : "trash" };
    },
    async stats() {
      calls.push(["stats"]);
      return {
        version: "0.0.0",
        home: "h",
        project: "p",
        index: { seq: 0, stale: false, builtAt: 0, sizeBytes: 0, overhead: 0 },
        shards: [],
        health: { overBudget: false, duplicateCandidates: 0, orphans: 0, lastConsolidate: 0 },
        extraction: { pending: 0, failed: 0, skipReasons: {} },
      };
    },
    noteModelWrite() {
      calls.push(["noteModelWrite"]);
    },
    async close() {
      calls.push(["close"]);
    },
  };
}

test("setup registers context+prompt hooks and five tools; version gate blocks v1", async () => {
  const good = mockCtx();
  await plugin.default.setup(good.ctx);
  assert.ok(good.hooks.has("context"), "context hook must be registered");
  assert.ok(good.hooks.has("prompt"), "prompt hook must be registered");
  assert.equal(good.tools.length, 5);
  assert.deepEqual(
    good.tools.map((t) => t.name),
    ["memory_write", "memory_search", "memory_read", "memory_forget", "memory_status"],
  );
  for (const t of good.tools) {
    assert.equal(typeof t.execute, "function");
    assert.equal(typeof t.description, "string");
    assert.ok(t.args && typeof t.args === "object");
  }

  const bad = mockCtx({ version: "1.19.5" });
  await plugin.default.setup(bad.ctx);
  assert.equal(bad.hooks.size, 0, "v1 host must get no hooks");
  assert.equal(bad.tools.length, 0, "v1 host must get no tools");
});

function wireState(ctx, directory, engineFactory) {
  const opened = [];
  const state = createPluginState({
    openEngine: async (settings, opts) => {
      opened.push(opts);
      return engineFactory();
    },
  });
  state.ctx = { session: ctx.session };
  state.fallbackCwd = directory;
  state.settingsFor(directory);
  return { state, opened };
}

test("injection is byte-stable per session and honors the byte cap", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-oc-inject-"));
  const dir = await mkdtemp(path.join(os.tmpdir(), "harnmem-oc-cwd-"));
  try {
    // Real vendored core here: the snapshot text itself must come from core.
    // Open with cwd so the project bucket matches the one the plugin resolves.
    const core = await import(pathToFileURL(path.join(pkgRoot, "vendor", "core", "index.js")).href);
    const seed = await core.HarnMem.open({ home, harness: "opencode", sessionId: "seed", cwd: dir });
    await seed.write({ type: "project", title: "OC inject marker", description: "marker", content: "Use pnpm. **Why:** repo rule." });
    await seed.close();

    process.env.HARNMEM_HOME = home;
    delete process.env.HARNMEM_DISABLED;
    const { ctx } = mockCtx({ directory: dir });
    const state = createPluginState(); // real openEngine on purpose
    state.ctx = { session: ctx.session };
    state.fallbackCwd = dir;
    state.settingsFor(dir);

    const sys = [];
    await state.onContext({ sessionID: "s1", system: sys });
    assert.equal(sys.length, 1, "seeded store must inject");
    assert.equal(sys[0].type, "text");
    assert.ok(sys[0].text.includes("OC inject marker"), "seeded title must appear");
    assert.ok(Buffer.byteLength(sys[0].text, "utf8") <= 10_000, "must respect the injection cap");

    const sys2 = [];
    await state.onContext({ sessionID: "s1", system: sys2 });
    assert.equal(sys2.length, 1);
    assert.equal(sys2[0].text, sys[0].text, "same session must push byte-identical text");
  } finally {
    delete process.env.HARNMEM_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompt hook journals the transcript tail and dedupes by signature", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-oc-journal-"));
  const dir = await mkdtemp(path.join(os.tmpdir(), "harnmem-oc-jcwd-"));
  try {
    process.env.HARNMEM_HOME = home;
    const { ctx } = mockCtx({ directory: dir });
    const { state } = wireState(ctx, dir, mockEngine);

    await state.onPrompt({ sessionID: "s9" });
    const eng = state.engines.get(`rw:${dir}#s9`);
    assert.ok(eng, "mock engine must be cached per (mode,cwd,session)");
    const journalCall = eng.calls.find(([name]) => name === "sessionEnd");
    assert.ok(journalCall, "sessionEnd must be called");
    assert.equal(journalCall[1].sessionId, "s9");
    assert.equal(journalCall[1].cwd, dir);
    assert.equal(journalCall[1].reason, "turn");
    assert.equal(journalCall[1].messages.length, 2);
    assert.equal(journalCall[1].messages[0].text, "hello from s9");

    const before = eng.calls.length;
    await state.onPrompt({ sessionID: "s9" });
    assert.equal(eng.calls.length, before, "unchanged transcript must not re-journal");
  } finally {
    delete process.env.HARNMEM_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool execute: write clamps + notes model writes; bare args map onto query", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-oc-tool-"));
  const dir = await mkdtemp(path.join(os.tmpdir(), "harnmem-oc-tcwd-"));
  try {
    process.env.HARNMEM_HOME = home;
    const { ctx } = mockCtx({ directory: dir });
    const { state } = wireState(ctx, dir, mockEngine);

    const r1 = await state.toolWrite({ type: "project", title: "T", content: "C", importance: 99, confidence: -3 }, { sessionID: "s5" });
    assert.equal(r1.content[0].text, "stored mem_new (NEW)");
    const eng = state.engines.get(`rw:${dir}#s5`);
    const writeCall = eng.calls.find(([n]) => n === "write");
    assert.equal(writeCall[1].importance, 10, "importance must clamp to 10");
    assert.equal(writeCall[1].confidence, 0, "confidence must clamp to 0");
    assert.ok(eng.calls.some(([n]) => n === "noteModelWrite"), "write must noteModelWrite");

    // null/junk numerics must be dropped, not coerced to 0 (core defaults apply).
    await state.toolWrite({ type: "project", title: "T2", content: "C2", importance: null, confidence: "abc" }, { sessionID: "s5" });
    const writeCall2 = eng.calls.filter(([n]) => n === "write")[1];
    assert.equal("importance" in writeCall2[1], false, "null importance must be deleted, not zeroed");
    assert.equal("confidence" in writeCall2[1], false, "non-numeric confidence must be deleted, not zeroed");

    const r2 = await state.toolSearch("find it", { sessionID: "s5" });
    assert.match(r2.content[0].text, /no confident memories/);
    const searchCall = eng.calls.find(([n]) => n === "search");
    assert.equal(searchCall[1].query, "find it", "bare-string args must map onto query");

    const r3 = await state.toolForget({ id: "mem_x" }, { sessionID: "s5" });
    assert.match(r3.content[0].text, /moved mem_x to trash/);
    const r4 = await state.toolStatus({}, { sessionID: "s5" });
    assert.match(r4.content[0].text, /harnmem v/);

    // Disabled store: tools answer with a friendly line instead of failing.
    process.env.HARNMEM_DISABLED = "1";
    state.settingsCache.clear();
    const r5 = await state.toolStatus({}, { sessionID: "s5" });
    assert.match(r5.content[0].text, /disabled/);
  } finally {
    delete process.env.HARNMEM_HOME;
    delete process.env.HARNMEM_DISABLED;
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("a transient engine failure does not permanently kill injection for the session", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-oc-retry-"));
  const dir = await mkdtemp(path.join(os.tmpdir(), "harnmem-oc-rcwd-"));
  try {
    // Seed a real store so injection would succeed once the engine opens.
    const core = await import(pathToFileURL(path.join(pkgRoot, "vendor", "core", "index.js")).href);
    const seed = await core.HarnMem.open({ home, harness: "opencode", sessionId: "seed", cwd: dir });
    await seed.write({ type: "project", title: "OC retry marker", description: "marker", content: "Use pnpm. **Why:** repo rule." });
    await seed.close();

    process.env.HARNMEM_HOME = home;
    delete process.env.HARNMEM_DISABLED;
    const { ctx } = mockCtx({ directory: dir });
    const state = createPluginState();
    state.ctx = { session: ctx.session };
    state.fallbackCwd = dir;
    state.settingsFor(dir);

    // First request: openEngine throws transiently (file lock etc.).
    const realOpen = state.deps.openEngine || (await import(pathToFileURL(path.join(pkgRoot, "lib", "engine.mjs")).href)).openEngine;
    let fail = true;
    state.deps.openEngine = async (settings, opts) => {
      if (fail) throw new Error("ELOCK transient");
      return realOpen(settings, opts);
    };

    const sys1 = [];
    await state.onContext({ sessionID: "sR", system: sys1 });
    assert.equal(sys1.length, 0, "failed request must inject nothing");
    const sess = state.sessions.get("sR");
    assert.equal(sess.injectText, undefined, "failure must not cache an injection result");

    // Second request: the transient failure is gone -> injection happens.
    fail = false;
    const sys2 = [];
    await state.onContext({ sessionID: "sR", system: sys2 });
    assert.equal(sys2.length, 1, "next request must retry and inject");
    assert.ok(sys2[0].text.includes("OC retry marker"));
  } finally {
    delete process.env.HARNMEM_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("subagent child sessions (parentID) are read-only and never poison the main session", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-oc-sub-"));
  const dir = await mkdtemp(path.join(os.tmpdir(), "harnmem-oc-subcwd-"));
  try {
    process.env.HARNMEM_HOME = home;
    const { ctx } = mockCtx({
      directory: dir,
      sessionRecord: { id: "child", parentID: "parent", location: { directory: dir } },
    });
    const { state, opened } = wireState(ctx, dir, mockEngine);

    const sys = [];
    await state.onContext({ sessionID: "child", system: sys });
    assert.equal(sys.length, 0, "subagent sessions must not inject");

    await state.onPrompt({ sessionID: "child" });
    assert.equal(opened.length, 0, "inject/journal paths must not open any engine for a subagent");
    assert.equal(state.engines.size, 0, "no engine cached for a subagent after inject+journal");

    // Tool path: a subagent calling memory tools opens its OWN read-only
    // engine (search/read work; writes go through the ro-keyed engine).
    await state.toolSearch("q", { sessionID: "child" });
    assert.equal(opened.length, 1, "tool path must open exactly one engine for the subagent");
    assert.equal(opened[0].readOnly, true, "subagent engine must be opened read-only");
    assert.ok(state.engines.has(`ro:${dir}#child`), "subagent engine keyed under ro:");
    assert.ok(state.engines.get(`ro:${dir}#child`).calls.some(([n]) => n === "search"), "subagent search must reach its engine");
    assert.ok(!state.engines.get(`ro:${dir}#child`).calls.some(([n]) => n === "sessionEnd"), "subagent sessions must not journal");

    // M1 regression: the main session (no parentID, same cwd) must get its
    // own rw-keyed engine — never the subagent's read-only one.
    const main = mockCtx({ directory: dir });
    const { state: mainState, opened: mainOpened } = wireState(main.ctx, dir, mockEngine);
    mainState.sessions = state.sessions; // same process, shared session table
    const r = await mainState.toolWrite({ type: "project", title: "T", content: "C" }, { sessionID: "main" });
    assert.match(r.content[0].text, /stored mem_new/);
    assert.equal(mainOpened[0].readOnly, false, "main-session write engine must be read-write");
    assert.ok(mainState.engines.has(`rw:${dir}#main`), "main engine keyed under rw:");
    assert.notEqual(mainState.engines.get(`rw:${dir}#main`), state.engines.get(`ro:${dir}#child`), "main and subagent engines must be distinct objects");
  } finally {
    delete process.env.HARNMEM_HOME;
    await rm(home, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});
