/**
 * Lifecycle/injection/tools integration tests against a fake DSH host context.
 * Run after `pnpm --filter dsh-harnmem build` (imports ../dist).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { apply, inject, name as pluginName } from "../dist/index.js";
import { createFakeContext, fakeAgent, waitForLog } from "./fake-dsh.mjs";

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function boot({ config = undefined, agentOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-harnmem-test-"));
  roots.push(root);
  const home = join(root, "home");
  process.env["HARNMEM_HOME"] = home;
  const host = createFakeContext();
  await apply(host.ctx, config);
  const agent = fakeAgent({ sessionId: `s-${root}`, cwd: join(root, "proj"), ...agentOptions });
  await host.emit("agent/created", { agent });
  await waitForLog(host, "session.started");
  return { root, home, host, agent };
}

async function callTool(host, name, args, agent) {
  const definition = host.tool(name);
  return definition.execute(args, { agent });
}

test("plugin exports: named only, stable inject and section at order 4050", () => {
  assert.equal(pluginName, "dsh-harnmem");
  assert.deepEqual(inject, ["systemPrompt", "tools"]);
});

test("empty store injects an empty string (zero tokens)", async () => {
  const { host, agent } = await boot();
  assert.equal(host.sectionText(agent), "");
  assert.equal(host.sectionText(agent), "");
});

test("harnmem_write is visible on the next step and stays byte-identical afterwards", async () => {
  const { host, agent } = await boot();
  const written = await callTool(
    host,
    "harnmem_write",
    {
      type: "project",
      title: "检索方案：纯 JS BM25F",
      description: "默认检索使用纯 JS BM25F，不引入向量库",
      content: "项目决定使用纯 JS BM25F + CJK bigram 做默认检索。Why: 零依赖。",
      tags: ["检索", "决策"],
    },
    agent,
  );
  assert.match(written, /^stored mem_/);

  await host.emit("agent/pre-step", { agent }, () => undefined);
  const first = host.sectionText(agent);
  assert.ok(first.includes("检索方案：纯 JS BM25F"), "hot index contains the new memory");

  await host.emit("agent/pre-step", { agent }, () => undefined);
  const second = host.sectionText(agent);
  assert.equal(second, first, "steady-state injection bytes are identical");

  // The section is re-evaluated on every step but must not allocate new text.
  assert.equal(host.sectionText(agent), first);
});

test("harnmem_search returns compact JSON and matches a Chinese query", async () => {
  const { host, agent } = await boot();
  await callTool(
    host,
    "harnmem_write",
    {
      type: "project",
      title: "决策：检索使用纯 JS",
      description: "不引入向量库，纯 JS BM25F",
      content: "默认检索实现是纯 JS BM25F，零依赖。",
    },
    agent,
  );
  const raw = await callTool(host, "harnmem_search", { query: "检索", limit: 5 }, agent);
  const payload = JSON.parse(raw);
  assert.equal(payload.query, "检索");
  assert.ok(payload.results.length >= 1);
  assert.ok(payload.results[0].id.startsWith("mem_"));
  assert.ok(raw.includes("hint"));
});

test("harnmem_status reports the store health", async () => {
  const { host, agent } = await boot();
  const text = await callTool(host, "harnmem_status", {}, agent);
  assert.match(text, /harnmem 1/);
  assert.match(text, /index seq=/);
});

test("compaction marks the snapshot dirty and rebuilds it", async () => {
  const { host, agent } = await boot();
  await host.emit("session/event", { id: agent.session.id }, { type: "compaction/end" });
  const log = await waitForLog(host, "session.compacted");
  assert.equal(log.data.sessionId, agent.session.id);
});

test("child agents are read-only: no writes, no extraction", async () => {
  const { host, agent } = await boot({ agentOptions: { depth: 1 } });
  const result = await callTool(
    host,
    "harnmem_write",
    { type: "project", title: "child write", description: "must fail", content: "must fail" },
    agent,
  );
  assert.match(result, /read-only/i);
  // Read paths still work.
  const search = await callTool(host, "harnmem_search", { query: "anything" }, agent);
  assert.ok(JSON.parse(search).total === 0);
});

test("session dispose runs sessionEnd and reports no_llm without a host LLM", async () => {
  const { host, agent } = await boot();
  await host.emit("agent/disposed", { agent });
  const log = await waitForLog(host, "session.end");
  assert.equal(log.data.status, "no_llm");
  assert.equal(log.data.sessionId, agent.session.id);
});

test("session/disposed and effect cleanup close remaining engines", async () => {
  const { host, agent } = await boot();
  assert.ok(host.has("session/disposed"));
  const cleanups = host.effectCleanups();
  assert.equal(cleanups.length, 1);
  await host.emit("session/disposed", { id: agent.session.id });
  await waitForLog(host, "session.disposed");
  await assert.doesNotReject(cleanups[0]());
});

test("tool registration failure degrades to injection-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-harnmem-degrade-"));
  roots.push(root);
  process.env["HARNMEM_HOME"] = join(root, "home");
  const host = createFakeContext();
  host.ctx.tools.register = () => {
    throw new Error("boom");
  };
  await apply(host.ctx, undefined);
  const agent = fakeAgent({ sessionId: `s-${root}`, cwd: join(root, "proj") });
  await host.emit("agent/created", { agent });
  await waitForLog(host, "session.started");
  // Section still works; every tool registration was reported.
  assert.equal(host.sectionText(agent), "");
  const log = host.logsWith("tools.registered")[0];
  assert.equal(log.data.count, 0);
  assert.equal(log.data.of, 5);
  const failures = host.logsWith("tool.registerFailed");
  assert.equal(failures.length, 5);
});

test("agent/session-start is registered defensively for resume", async () => {
  const { host } = await boot();
  assert.ok(host.has("agent/session-start"));
});

test("cold start: persisted memory is injected before the async attach settles", async () => {
  // First session persists a pinned memory and its shard index.
  const first = await boot();
  await callTool(
    first.host,
    "harnmem_write",
    {
      type: "user",
      title: "Codename",
      description: "The user codename is BLUE-FALCON-77",
      content: "The user codename is BLUE-FALCON-77.",
      pinned: true,
    },
    first.agent,
  );
  // A pre-step rebuild saves the index JSON the synchronous fallback reads.
  await first.host.emit("agent/pre-step", { agent: first.agent }, () => undefined);
  assert.ok(first.host.sectionText(first.agent).includes("Codename"));
  await first.host.emit("agent/disposed", { agent: first.agent });
  await waitForLog(first.host, "session.disposed");

  // Second process/session: the section callback is evaluated before attach awaits.
  const host2 = createFakeContext();
  process.env["HARNMEM_HOME"] = first.home;
  await apply(host2.ctx, undefined);
  const agent2 = fakeAgent({ sessionId: `s-cold-${first.root}`, cwd: join(first.root, "proj") });
  void host2.emit("agent/created", { agent: agent2 });
  const coldText = host2.sectionText(agent2);
  assert.ok(coldText.includes("Codename"), "cold-start fallback reads the persisted index");
  assert.ok(coldText.includes("BLUE-FALCON-77"));
  await waitForLog(host2, "session.started");
  // Once the snapshot is primed the engine path serves the same block.
  assert.ok(host2.sectionText(agent2).includes("Codename"));
  await host2.emit("agent/disposed", { agent: agent2 });
});

test("default prefix harnmem_ keeps the bare memory_* names free for dsh-auto-memory", async () => {
  const { host } = await boot();
  assert.deepEqual(
    host.tools.map((definition) => definition.name),
    ["harnmem_write", "harnmem_search", "harnmem_read", "harnmem_forget", "harnmem_status"],
  );
});

test("toolPrefix is configurable and normalised to end with an underscore", async () => {
  const { host } = await boot({ config: { toolPrefix: "hm" } });
  assert.equal(host.tool("hm_write").name, "hm_write");
  assert.throws(() => host.tool("harnmem_write"), /not registered/);
});

test("dispose is idempotent across agent/disposed and session/disposed", async () => {
  const { host, agent } = await boot();
  await Promise.all([
    host.emit("agent/disposed", { agent }),
    host.emit("session/disposed", { id: agent.session.id }),
  ]);
  assert.equal(host.logsWith("session.end").length, 1);
});

test("dsh.jsonl file log records plugin.apply and the extraction outcome", async () => {
  const { home, host, agent } = await boot();
  await host.emit("agent/disposed", { agent });
  await waitForLog(host, "session.end");
  for (const cleanup of host.effectCleanups()) await cleanup();
  const raw = await readFile(join(home, "logs", "dsh.jsonl"), "utf8");
  assert.match(raw, /"msg":"plugin\.apply"/);
  assert.match(raw, /"msg":"session\.end"/);
  assert.match(raw, /"status":"no_llm"/);
});

test('log: "off" creates no file sink', async () => {
  const { home, host, agent } = await boot({ config: { log: "off" } });
  await host.emit("agent/disposed", { agent });
  await waitForLog(host, "session.end");
  for (const cleanup of host.effectCleanups()) await cleanup();
  await assert.rejects(readFile(join(home, "logs", "dsh.jsonl"), "utf8"), /ENOENT/);
});

function dayStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function sanitizeFilePart(input) {
  return input.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "x";
}

async function writeJournal(home, sessionId, entries) {
  const dir = join(home, "sessions", dayStamp(Date.now()));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `dsh_${sanitizeFilePart(sessionId)}.jsonl`);
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

test("resumed session hydrates its digest from the persisted journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-harnmem-hydrate-"));
  roots.push(root);
  const home = join(root, "home");
  const sessionId = `s-hydrate-${root}`;
  const cwd = join(root, "proj");
  await writeJournal(home, sessionId, [
    { ts: 1, role: "user", text: "one: the user prefers pnpm", cwd },
    { ts: 2, role: "assistant", text: "Noted.", cwd },
    { ts: 3, role: "user", text: "two: never use npm", cwd },
  ]);
  process.env["HARNMEM_HOME"] = home;
  const host = createFakeContext();
  await apply(host.ctx, undefined);
  const agent = fakeAgent({ sessionId, cwd });
  await host.emit("agent/created", { agent });
  const hydrated = await waitForLog(host, "digest.hydrated");
  assert.equal(hydrated.data.entries, 3);
  assert.equal(hydrated.data.userMessages, 2);

  // The quit-time extraction sees the rehydrated prompts instead of an empty
  // process-local digest (the N2 failure mode was `userMessages = 0`).
  await host.emit("agent/disposed", { agent });
  const end = await waitForLog(host, "session.end");
  assert.equal(end.data.digestEntries, 3);
  assert.equal(end.data.userMessages, 2);
});

test("dispose falls back to the journal when the session digest is short", async () => {
  const { home, host, agent } = await boot();
  // e.g. the adapter started recording late, or a previous process wrote more.
  await writeJournal(home, agent.session.id, [
    { ts: 1, role: "user", text: "one", cwd: agent.session.header.cwd },
    { ts: 2, role: "user", text: "two", cwd: agent.session.header.cwd },
    { ts: 3, role: "user", text: "three", cwd: agent.session.header.cwd },
  ]);
  await host.emit("agent/disposed", { agent });
  const hydrated = await waitForLog(host, "session.endHydrated");
  assert.equal(hydrated.data.userMessages, 3);
  // `waitForLog` uses substring matching, so pick the exact outcome line.
  const end = host.logs.find((entry) => String(entry.message).endsWith("session.end"));
  assert.ok(end, "session.end was logged");
  assert.equal(end.data.userMessages, 3);
  assert.equal(end.data.digestEntries, 3);
});

test("resume catch-up extracts the hydrated journal while the llm service is alive", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-harnmem-catchup-"));
  roots.push(root);
  const home = join(root, "home");
  const sessionId = `s-catchup-${root}`;
  const cwd = join(root, "proj");
  const filler =
    "仓库里的所有子包必须统一使用 pnpm 安装依赖，锁文件只保留 pnpm-lock.yaml；脚本、文档和 CI 配置中出现的 npm 命令都要改成对应的 pnpm 命令，如果有人误用 npm，需要在 code review 中指出并修正。";
  const memoryJson = JSON.stringify({
    memories: [
      {
        type: "project",
        scope: "project",
        title: "pnpm only",
        description: "All packages use pnpm exclusively",
        content: "Always use pnpm. Why: one lockfile. How to apply: prefer pnpm in scripts, docs and CI.",
        confidence: 0.9,
      },
    ],
  });
  await writeJournal(home, sessionId, [
    { ts: 1, role: "user", text: `第一轮：${filler}${filler}`, cwd },
    { ts: 2, role: "assistant", text: "好的，记下了。", cwd },
    { ts: 3, role: "user", text: `第二轮：${filler}${filler}`, cwd },
    { ts: 4, role: "user", text: `第三轮：${filler}${filler}`, cwd },
  ]);
  process.env["HARNMEM_HOME"] = home;
  const host = createFakeContext();
  // Minimal host llm service: enough for the adapter's protocol bridge.
  host.provide("llm", {
    async *stream() {
      yield { type: "text-delta", text: memoryJson };
      yield { type: "finish", reason: { kind: "end" } };
    },
  });
  await apply(host.ctx, undefined);
  const agent = fakeAgent({ sessionId, cwd, provider: "fake-provider", model: "fake-model" });
  await host.emit("agent/created", { agent });

  // The quit itself cannot extract (providers are already gone at
  // `plugin_unload`), so the next attach finishes the job while the LLM lives.
  const catchup = await waitForLog(host, "extract.catchup");
  assert.equal(catchup.data.status, "done");
  assert.equal(catchup.data.added, 1);
  assert.equal(catchup.data.userMessages, 3);

  // The dispose that follows must not extract — that is exactly the mode that
  // used to exit with NO_ADAPTER before the LLM is torn down.
  await host.emit("agent/disposed", { agent });
  const end = host.logs.find((entry) => String(entry.message).endsWith("session.end"));
  assert.ok(end, "session.end was logged");
  assert.equal(end.data.status, "skipped");
  assert.equal(end.data.skipReason, "already_extracted");
});

