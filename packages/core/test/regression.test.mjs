import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HarnMem } from "../dist/index.js";

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fresh(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnmem-regression-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "work", "proj");
  const eng = await HarnMem.open({ harness: "cli", cwd, home, project: "proj", autoExtract: false, ...options });
  return { root, home, cwd, eng };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// F1: search({asOf}) time travel — a record still valid at asOf must be
// visible, and a record born after asOf must not be.
test("asOf time travel returns the version valid at that instant", async () => {
  const { eng } = await fresh();
  await sleep(5);
  const a = await eng.write({
    type: "project",
    title: "Router choice verdict alpha",
    description: "router alpha",
    content: "Router pick alpha nginx zero deps for the edge gateway.",
    tags: ["router"],
  });
  await sleep(12);
  const tMid = Date.now();
  await sleep(12);
  const b = await eng.write({
    type: "project",
    title: "Router choice verdict beta",
    description: "router beta",
    content: "Router pick beta envoy for the edge gateway.",
    supersedes: [a.id],
  });
  await sleep(12);

  const nowRes = await eng.search({ query: "router", asOf: Date.now() + 1000 });
  assert.ok(nowRes.results.some((r) => r.id === b.id), "successor visible now");
  assert.ok(!nowRes.results.some((r) => r.id === a.id), "superseded record hidden now");

  const pastRes = await eng.search({ query: "router", asOf: tMid });
  assert.ok(pastRes.results.some((r) => r.id === a.id), "A must be visible at tMid (it was still valid)");
  assert.ok(!pastRes.results.some((r) => r.id === b.id), "B must not predate itself");
});

// F2: a long-lived process calling sessionEnd repeatedly as the session grows
// must extract the newer turns — the durable audit is authoritative, the
// in-memory flag is only a fallback.
test("same-process sessionEnd with grown messages extracts the new turns", async () => {
  const calls = [];
  const { eng } = await fresh({
    autoExtract: true,
    llm: async () => {
      calls.push(1);
      return { text: JSON.stringify({ memories: [] }) };
    },
    write: { autoExtract: true, minUserMessages: 2, minDigestChars: 20, minConfidence: 0, llmTimeoutMs: 5000 },
  });
  const msgs = (n) => Array.from({ length: n }, (_, i) => ({ role: "user", text: `growth message number ${i}` }));
  const first = await eng.sessionEnd({ sessionId: "grow", messages: msgs(3) });
  assert.equal(first.status, "done");
  const second = await eng.sessionEnd({ sessionId: "grow", messages: msgs(5) });
  assert.equal(second.status, "done", "grown session must re-extract in the same process");
  assert.equal(second.skipReason, undefined);
  assert.equal(calls.length, 2, "llm called once per real extraction");
  const third = await eng.sessionEnd({ sessionId: "grow", messages: msgs(5) });
  assert.equal(third.skipReason, "already_extracted", "no growth means no re-extraction");
  assert.equal(calls.length, 2);
});

// F3: hostile project names and record ids must never escape <home>.
test("hostile project string and record id stay inside home", async () => {
  const { eng, home, root } = await fresh({ project: "../../pwn" });
  const res = await eng.write({
    type: "project",
    title: "Escape attempt record",
    description: "traversal",
    content: "Hostile project name must stay inside home.",
  });
  const readBack = await eng.read(res.id);
  assert.ok(readBack, "record written under sanitized shard is readable");
  assert.equal(readBack.record.id, res.id);

  const projectsDir = join(home, "memories", "projects");
  for (const entry of await readdir(projectsDir)) {
    assert.match(entry, /^[A-Za-z0-9_.-]+$/, "shard directory name is file-safe");
    assert.notEqual(entry, "..");
    assert.notEqual(entry, ".");
  }
  assert.ok(!existsSync(join(root, "pwn")), "nothing outside home");
  assert.ok(!existsSync(join(home, "pwn")), "nothing directly under home");
  assert.ok(!existsSync(join(home, "memories", "pwn")), "nothing next to projects dir");

  const imported = await eng.importRecords([
    {
      id: "mem_x/../../evil",
      type: "reference",
      scope: "project",
      title: "Hostile id import",
      description: "id must be sanitized into the shard",
      content: "Hostile record id must stay inside the shard directory.",
    },
  ]);
  const evilRead = await eng.read(imported.ids[0]);
  assert.ok(evilRead, "hostile id round-trips through the sanitized filename");
  const shardDir = join(projectsDir, ".._.._pwn");
  for (const entry of await readdir(shardDir)) {
    assert.match(entry, /^[A-Za-z0-9_.-]+$/, "record filename is file-safe");
  }
  assert.ok(!existsSync(join(home, "memories", "evil.md")), "no escaped record file");
});

// F5: a truncated/corrupt .md must not resurrect as an active "(untitled)"
// record; it is surfaced as an error and skipped.
test("frontmatter-less file is skipped, not resurrected as untitled record", async () => {
  const { eng, home } = await fresh();
  const good = await eng.write({
    type: "project",
    title: "Good record for rebuild",
    description: "survives a broken neighbour",
    content: "Good record content that must stay searchable after rebuild.",
  });
  await writeFile(join(home, "memories", "projects", "proj", "broken.md"), "garbage without frontmatter", "utf8");
  await eng.rebuildIndex();
  const zombie = await eng.search({ query: "untitled" });
  assert.ok(!zombie.results.some((r) => r.title === "(untitled)"), "no zombie record");
  const still = await eng.search({ query: "rebuild" });
  assert.ok(still.results.some((r) => r.id === good.id), "good record still indexed");
});

// F6: maxBodyBytes truncation cuts on a UTF-8 boundary — CJK content must not
// exceed the byte budget by 3x and must never carry a broken surrogate/FFFD.
test("byte budget truncates on UTF-8 boundary", async () => {
  const { eng } = await fresh({ governance: { maxBodyBytes: 31 } });
  const w = await eng.write({
    type: "project",
    title: "CJK byte budget",
    description: "truncation boundary",
    content: "跨字节预算截断必须在多字节字符边界处进行，不能劈开任何汉字或代理对。",
  });
  const back = await eng.read(w.id);
  const body = back.record.content;
  assert.ok(!body.includes("\uFFFD"), "no replacement char from a split multibyte char");
  assert.ok(Buffer.byteLength(body, "utf8") <= 31 + 3, "body stays within budget plus ellipsis");
});

// F7: titles with embedded newlines survive the YAML round trip.
test("multi-line title survives frontmatter round trip", async () => {
  const { eng } = await fresh();
  const w = await eng.write({
    type: "reference",
    title: "line one\nline two",
    description: "multiline title",
    content: "Multi-line title must survive the YAML round trip.",
  });
  const back = await eng.read(w.id);
  assert.equal(back.record.title, "line one\nline two");
  await eng.rebuildIndex();
  const again = await eng.read(w.id);
  assert.equal(again.record.title, "line one\nline two", "still intact after index rebuild");
});

// F8: HARNMEM_ASSETS_DIR must be honored on every call, not read-once.
// deployDefaultAssets runs inside open(), so a home whose FIRST open happens
// under a fresh override must deploy THAT directory's content (marker probe).
test("HARNMEM_ASSETS_DIR repoint takes effect without process restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "harnmem-regression-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "work", "proj");
  const assetDir = join(root, "late-assets");
  await mkdir(join(assetDir, "prompts"), { recursive: true });
  await writeFile(join(assetDir, "prompts", "extract.md"), "# MARKER-LATE-ASSETS\n", "utf8");
  process.env.HARNMEM_ASSETS_DIR = assetDir;
  try {
    await HarnMem.open({ harness: "cli", cwd, home, project: "proj", autoExtract: false });
    const homePrompt = await readFile(join(home, "prompts", "extract.md"), "utf8");
    assert.ok(homePrompt.includes("MARKER-LATE-ASSETS"), "env override honored live at deploy time");
  } finally {
    delete process.env.HARNMEM_ASSETS_DIR;
  }
});
