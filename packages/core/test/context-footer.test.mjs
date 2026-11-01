import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HarnMem, contextFooter, renderContextText, CONTEXT_FOOTER, renderHotContextSync } from "../dist/index.js";

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fresh(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnmem-footer-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "work", "proj");
  const eng = await HarnMem.open({ harness: "cli", cwd, home, project: "proj", autoExtract: false, ...options });
  return { root, home, cwd, eng };
}

test("contextFooter reproduces the historical footer for the default prefix", () => {
  assert.equal(contextFooter(), CONTEXT_FOOTER);
  assert.equal(contextFooter(undefined), CONTEXT_FOOTER);
  assert.equal(contextFooter("memory_"), CONTEXT_FOOTER);
  assert.ok(CONTEXT_FOOTER.includes("Use memory_search for details"));
});

test("contextFooter swaps the search tool name and rejects invalid prefixes", () => {
  assert.equal(
    contextFooter("harnmem_"),
    "<!-- SSOT: ~/.harnmem. Use harnmem_search for details; never invent memory ids. Snapshot refreshes on session start, after memory writes and at day rollover. -->",
  );
  assert.equal(contextFooter("agent2_"), CONTEXT_FOOTER.replace("memory_search", "agent2_search"));
  for (const bad of ["1bad", "has space_", "", "a-b_", null, 42]) {
    assert.equal(contextFooter(bad), CONTEXT_FOOTER, `invalid prefix ${String(bad)} must fall back`);
  }
});

test("renderContextText keeps the default footer unless one is passed", () => {
  const text = renderContextText(["- [user] t — d"]);
  assert.ok(text.startsWith("## HarnMem memory"));
  assert.ok(text.endsWith(CONTEXT_FOOTER));
  const custom = renderContextText(["- [user] t — d"], contextFooter("harnmem_"));
  assert.ok(custom.includes("Use harnmem_search for details"));
});

test("injected snapshot names the configured tool prefix", async () => {
  const { eng } = await fresh({ toolPrefix: "harnmem_" });
  await eng.write({ type: "user", title: "Likes brief answers", description: "User prefers brief answers", content: "Keep answers brief." });
  const block = await eng.sessionStart({ sessionId: "s1" });
  assert.ok(block.text.includes("Use harnmem_search for details"));
  assert.ok(!block.text.includes("Use memory_search for details"));
});

test("default engine keeps the historical memory_search footer", async () => {
  const { eng } = await fresh();
  await eng.write({ type: "user", title: "Likes brief answers", description: "User prefers brief answers", content: "Keep answers brief." });
  const block = await eng.sessionStart({ sessionId: "s1" });
  assert.ok(block.text.includes("Use memory_search for details"));
});

test("renderHotContextSync honors config.toolPrefix in the cold-start path", async () => {
  const { home, cwd, eng } = await fresh({ toolPrefix: "harnmem_" });
  await eng.write({ type: "user", title: "Prefers terse replies", description: "User wants terse replies", content: "Reply tersely in this project." });
  // Writes do not persist the shard index; the first retrieval (sessionStart) does.
  await eng.sessionStart({ sessionId: "s1" });
  const result = renderHotContextSync({ home, cwd, config: { toolPrefix: "harnmem_" } });
  assert.ok(result.text !== "", "cold-start path should render with content present");
  assert.ok(result.text.includes("Use harnmem_search for details"));
});
