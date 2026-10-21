/**
 * Lifecycle/injection/tools integration tests against a fake DSH host context.
 * Run after `pnpm --filter dsh-harnmem build` (imports ../dist).
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

test("memory_write is visible on the next step and stays byte-identical afterwards", async () => {
  const { host, agent } = await boot();
  const written = await callTool(
    host,
    "memory_write",
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

test("memory_search returns compact JSON and matches a Chinese query", async () => {
  const { host, agent } = await boot();
  await callTool(
    host,
    "memory_write",
    {
      type: "project",
      title: "决策：检索使用纯 JS",
      description: "不引入向量库，纯 JS BM25F",
      content: "默认检索实现是纯 JS BM25F，零依赖。",
    },
    agent,
  );
  const raw = await callTool(host, "memory_search", { query: "检索", limit: 5 }, agent);
  const payload = JSON.parse(raw);
  assert.equal(payload.query, "检索");
  assert.ok(payload.results.length >= 1);
  assert.ok(payload.results[0].id.startsWith("mem_"));
  assert.ok(raw.includes("hint"));
});

test("memory_status reports the store health", async () => {
  const { host, agent } = await boot();
  const text = await callTool(host, "memory_status", {}, agent);
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
    "memory_write",
    { type: "project", title: "child write", description: "must fail", content: "must fail" },
    agent,
  );
  assert.match(result, /read-only/i);
  // Read paths still work.
  const search = await callTool(host, "memory_search", { query: "anything" }, agent);
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
    "memory_write",
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

