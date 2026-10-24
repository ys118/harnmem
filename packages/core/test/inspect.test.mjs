import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HarnMem, MemoryInspector, openInspector, renderHotContextSync } from "../dist/index.js";

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function freshHome() {
  const root = await mkdtemp(join(tmpdir(), "harnmem-inspect-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "work", "proj");
  return { root, home, cwd };
}

async function listFilesRecursive(dir, prefix = "") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(`${rel}/`, ...(await listFilesRecursive(join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** Seed a home through the public engine API: one user memory, one project memory. */
async function seeded(home, cwd) {
  // No explicit `project`: the engine detects + registers the project under `cwd`,
  // which is also what lets the sync hot-context reader resolve it.
  const eng = await HarnMem.open({ harness: "dsh", cwd, home, autoExtract: false });
  const user = await eng.write({
    type: "user",
    title: "Codename",
    description: "The user codename is BLUE-FALCON-77",
    content: "The user codename is BLUE-FALCON-77. Use it when the user asks for their codename.",
    pinned: true,
  });
  const project = await eng.write({
    type: "project",
    title: "Release process",
    description: "Tag the release branch before publishing",
    content: "Tag the release branch before publishing to npm.",
    tags: ["release"],
  });
  await eng.search({ query: "codename", limit: 3 });
  const projectId = eng.info().project ?? null;
  await eng.close();
  return { user, project, projectId };
}

test("inspector opens a missing home without creating it", async () => {
  const { home } = await freshHome();
  const inspector = await openInspector({ home });
  try {
    const overview = await inspector.overview();
    assert.equal(overview.version, 1);
    assert.equal(overview.home, home);
    assert.equal(overview.totals.records, 0);
    assert.deepEqual(overview.shards, []);
    assert.deepEqual(overview.fileErrors, []);
    assert.ok(overview.issues.some((issue) => issue.code === "empty_home"));
    assert.equal(await inspector.list({ shard: "all" }).then((list) => list.total), 0);
    assert.equal(await inspector.read({ id: "mem_missing" }), null);
    assert.equal(existsSync(home), false, "opening the inspector must not create the home");
  } finally {
    await inspector.close();
  }
});

test("overview, list, read and index text project on-disk records", async () => {
  const { home, cwd } = await freshHome();
  const { user, project, projectId } = await seeded(home, cwd);
  assert.ok(projectId, "engine resolved a project id");
  const inspector = await MemoryInspector.open({ home });
  try {
    const overview = await inspector.overview({ cwd });
    assert.equal(overview.totals.records, 2);
    assert.equal(overview.totals.active, 2);
    assert.equal(overview.totals.pinned, 1);
    assert.equal(overview.totals.shards, 2);
    assert.equal(overview.byType.user, 1);
    assert.equal(overview.byType.project, 1);
    assert.equal(overview.project, projectId);
    assert.ok(overview.totals.bytes > 0);
    assert.ok(overview.context.tokensEstimate > 0);
    assert.ok(overview.context.text.includes("Codename"));
    assert.equal(overview.fileErrors.length, 0);
    assert.deepEqual(overview.index.files.map((file) => file.shard).sort(), ["user", projectId].sort());
    assert.ok(overview.index.files.every((file) => file.exists && file.bytes > 0));

    const all = await inspector.list();
    assert.equal(all.total, 2);
    assert.equal(all.rows[0]?.id, user.id, "pinned memory sorts first");
    const row = all.rows.find((item) => item.id === project.id);
    assert.equal(row?.title, "Release process");
    assert.deepEqual(row?.tags, ["release"]);
    assert.equal(row?.project, projectId);
    assert.ok(row?.tokens > 0);

    const projectOnly = await inspector.list({ shard: projectId });
    assert.equal(projectOnly.total, 1);
    assert.equal(projectOnly.rows[0]?.id, project.id);
    assert.equal((await inspector.list({ shard: "does-not-exist" })).total, 0);

    const detail = await inspector.read({ id: user.id });
    assert.ok(detail);
    assert.equal(detail.id, user.id);
    assert.equal(detail.frontmatter.id, user.id);
    assert.equal(detail.frontmatter.scope, "user");
    assert.ok(detail.content.includes("BLUE-FALCON-77"));
    assert.ok(detail.raw.startsWith("---"), "detail keeps the verbatim file text");
    assert.equal(detail.filePath.startsWith("memories/"), true, `unexpected path ${detail.filePath}`);
    assert.equal(detail.bytes, Buffer.byteLength(detail.raw, "utf8"));
    assert.equal(detail.history, undefined);

    const indexText = await inspector.indexText({ shard: "user" });
    assert.equal(indexText.parts.length, 1);
    assert.ok(indexText.text.includes("Codename"));
    assert.equal(indexText.bytes, Buffer.byteLength(indexText.text, "utf8"));
    const combined = await inspector.indexText();
    assert.equal(combined.parts.length, 2);
    assert.ok(combined.text.includes("harnmem shard: user"));
  } finally {
    await inspector.close();
  }
});

test("reading through the inspector never mutates the home", async () => {
  const { home, cwd } = await freshHome();
  await seeded(home, cwd);
  const before = await listFilesRecursive(home);
  const projectsBefore = await readFile(join(home, "projects.json"), "utf8");
  const manifestPath = join(home, "index", "manifest.json");
  const manifestBefore = existsSync(manifestPath) ? await readFile(manifestPath, "utf8") : null;

  const inspector = await openInspector({ home, cacheTtlMs: 0 });
  try {
    const overview = await inspector.overview({ cwd });
    await inspector.list();
    await inspector.projects();
    await inspector.context({ cwd });
    await inspector.indexText();
    for (const shard of overview.shards) await inspector.list({ shard: shard.name });
    const first = overview.shards.find((shard) => shard.scope === "user");
    assert.ok(first);
    const list = await inspector.list({ shard: first.name });
    const row = list.rows[0];
    assert.ok(row);
    await inspector.read({ id: row.id, history: true });
  } finally {
    await inspector.close();
  }

  assert.deepEqual(await listFilesRecursive(home), before, "inspector must not add or remove files");
  assert.equal(await readFile(join(home, "projects.json"), "utf8"), projectsBefore);
  assert.equal(existsSync(manifestPath), manifestBefore !== null, "inspector must not create index/manifest.json");
  if (manifestBefore !== null) assert.equal(await readFile(manifestPath, "utf8"), manifestBefore);
});

test("supersede chains become history and links become backlinks", async () => {
  const { home, cwd } = await freshHome();
  const eng = await HarnMem.open({ harness: "dsh", cwd, home, autoExtract: false });
  let oldId;
  let newId;
  let linkerId;
  try {
    // Keep all three in one shard: links are validated per shard at write time.
    oldId = (await eng.write({ type: "project", title: "Editor", description: "The user edits in VS Code", content: "The user edits in VS Code." })).id;
    linkerId = (await eng.write({ type: "project", title: "Related", description: "See the editor preference", content: "See the editor preference.", links: [oldId] })).id;
    newId = (await eng.write({ type: "project", title: "Editor", description: "The user edits in Cursor now", content: "The user edits in Cursor now.", supersedes: [oldId] })).id;
    await eng.search({ query: "editor", limit: 5 });
  } finally {
    await eng.close();
  }

  const inspector = await openInspector({ home });
  try {
    const detail = await inspector.read({ id: oldId, history: true });
    assert.ok(detail);
    assert.equal(detail.status, "superseded");
    assert.equal(detail.supersededBy, newId);
    assert.deepEqual(detail.history?.map((row) => row.id), [newId], "history walks supersededBy forward");
    assert.ok(detail.backlinks.includes(linkerId), "backlinks include records whose links point here");

    const plain = await inspector.read({ id: oldId });
    assert.equal(plain?.history, undefined);
    assert.equal(plain?.status, "superseded");

    const list = await inspector.list({ includeInactive: false });
    assert.equal(list.rows.some((row) => row.id === oldId), false);
    assert.equal(list.rows.some((row) => row.id === newId), true);
  } finally {
    await inspector.close();
  }
});

test("context preview replays the injected block and honours a budget", async () => {
  const { home, cwd } = await freshHome();
  await seeded(home, cwd);
  const inspector = await openInspector({ home });
  try {
    const context = await inspector.context({ cwd });
    const sync = renderHotContextSync({ home, cwd });
    assert.equal(context.text, sync.text);
    assert.deepEqual(context.ids, sync.ids);
    assert.equal(context.tokensEstimate, sync.tokensEstimate);
    assert.deepEqual(context.shards, sync.shards);
    assert.ok(context.projectId);

    const tiny = await inspector.context({ cwd, budgetTokens: 80 });
    assert.ok(tiny.tokensEstimate <= 80);
    assert.equal(tiny.budgetTokens, 80);
  } finally {
    await inspector.close();
  }
});

test("index staleness and orphan index files are reported as issues", async () => {
  const { home, cwd } = await freshHome();
  await seeded(home, cwd);
  await writeFile(
    join(home, "index", "manifest.json"),
    JSON.stringify({ version: 1, seq: 0, builtAt: 0, shards: [] }),
    "utf8",
  );
  await writeFile(join(home, "index", "ghost-beefcafe01.json"), JSON.stringify({ version: 1, docs: [] }), "utf8");

  const inspector = await openInspector({ home });
  try {
    const overview = await inspector.overview({ cwd });
    assert.equal(overview.index.manifest?.seq, 0);
    assert.ok(overview.index.seq > 0);
    assert.equal(overview.index.stale, true);
    const codes = new Set(overview.issues.map((issue) => issue.code));
    assert.ok(codes.has("index_stale"), [...codes].join(","));
    assert.ok(codes.has("index_orphan"), [...codes].join(","));

    const ghost = overview.index.files.find((file) => file.shard === "ghost-beefcafe01");
    assert.ok(ghost);
    assert.equal(ghost.exists, true);
    assert.equal(ghost.records, 0);
  } finally {
    await inspector.close();
  }
});
