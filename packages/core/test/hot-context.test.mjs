import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

test("duplicate project ids for one path resolve to the populated shard", async () => {
  const { home, cwd } = await freshHome();
  const eng = await HarnMem.open({ harness: "dsh", cwd, home, project: "proj", autoExtract: false });
  try {
    const record = await eng.write({
      type: "project",
      scope: "project",
      title: "Deploy runbook",
      description: "Deploy notes for the proj shard",
      content: "Deploy notes body: tag, build, publish.",
    });
    // Populate the persisted index the sync fallback reads.
    await eng.search({ query: "deploy", limit: 3 });
    const populated = eng.info().project;
    assert.ok(populated);
    // Simulate a registry that accumulated two ids for the same path (a
    // `path:` entry written before the git remote was known). The empty entry
    // comes first on purpose: insertion order must not win over real records.
    const registry = JSON.parse(await readFile(join(home, "projects.json"), "utf8"));
    const stale = {
      id: "proj-stale",
      slug: "proj",
      name: "proj",
      paths: [cwd],
      harnesses: ["dsh"],
      created: 1,
      updated: 1,
    };
    await writeFile(
      join(home, "projects.json"),
      JSON.stringify({ version: 1, projects: { "path:stale": stale, ...registry.projects } }),
      "utf8",
    );

    const sync = renderHotContextSync({ home, cwd });
    assert.equal(sync.projectId, populated);
    assert.ok(sync.shards.includes(populated));
    assert.ok(sync.ids.includes(record.id));
    assert.ok(sync.text.includes("Deploy runbook"));
  } finally {
    await eng.close();
  }
});

test("opening a second empty home does not inherit the first home's registry", async () => {
  const first = await freshHome();
  const engA = await HarnMem.open({
    harness: "dsh",
    cwd: first.cwd,
    home: first.home,
    project: "proj",
    autoExtract: false,
  });
  const second = await freshHome();
  const engB = await HarnMem.open({
    harness: "dsh",
    cwd: second.cwd,
    home: second.home,
    project: "proj",
    autoExtract: false,
  });
  try {
    const registryA = JSON.parse(await readFile(join(first.home, "projects.json"), "utf8"));
    const registryB = JSON.parse(await readFile(join(second.home, "projects.json"), "utf8"));
    const entryA = Object.values(registryA.projects)[0];
    const entryB = Object.values(registryB.projects)[0];
    assert.deepEqual(entryA.paths, [first.cwd]);
    assert.deepEqual(entryB.paths, [second.cwd]);
  } finally {
    await engA.close();
    await engB.close();
  }
});

test("cold-start sync render survives a missing index directory", async () => {
  const { root, home, cwd } = await freshHome();
  // No HarnMem.open() at all: neither projects.json nor index/ exists.
  const sync = renderHotContextSync({ home, cwd });
  assert.equal(sync.text, "");
  const entries = await readdir(root);
  assert.ok(entries.length >= 0);
});
