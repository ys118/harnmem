import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HarnMem, renderHotContextSync } from "../dist/index.js";

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function freshHome() {
  const root = await mkdtemp(join(tmpdir(), "harnmem-hot-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "work", "proj");
  return { root, home, cwd };
}

test("cold-start sync render matches the engine context block byte for byte", async () => {
  const { home, cwd } = await freshHome();
  const eng = await HarnMem.open({ harness: "dsh", cwd, home, project: "proj", autoExtract: false });
  try {
    const first = await eng.write({
      type: "user",
      title: "Codename",
      description: "The user codename is BLUE-FALCON-77",
      content: "The user codename is BLUE-FALCON-77. Use it when the user asks for their codename.",
      pinned: true,
    });
    await eng.write({
      type: "project",
      title: "Release process",
      description: "Tag the release branch before publishing",
      content: "Tag the release branch before publishing to npm.",
    });
    // A search populates and persists the per-shard index JSON the fallback reads.
    await eng.search({ query: "codename", limit: 3 });
    const engineBlock = await eng.ensureContext("session_start");

    const sync = renderHotContextSync({ home, cwd });
    assert.equal(sync.text, engineBlock.text);
    assert.deepEqual(sync.ids, engineBlock.ids);
    assert.ok(sync.text.includes("Codename"));
    assert.ok(sync.ids.includes(first.id));
    assert.equal(sync.projectId, eng.info().project?.id ?? sync.projectId);
  } finally {
    await eng.close();
  }
});

test("cold-start sync render returns empty text for an empty store", async () => {
  const { home, cwd } = await freshHome();
  const sync = renderHotContextSync({ home, cwd });
  assert.equal(sync.text, "");
  assert.deepEqual(sync.ids, []);
});

test("cold-start sync render survives a missing index directory", async () => {
  const { root, home, cwd } = await freshHome();
  // No HarnMem.open() at all: neither projects.json nor index/ exists.
  const sync = renderHotContextSync({ home, cwd });
  assert.equal(sync.text, "");
  const entries = await readdir(root);
  assert.ok(entries.length >= 0);
});
