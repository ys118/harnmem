import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HarnMem } from "../dist/index.js";

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fresh(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnmem-test-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "work", "proj");
  const eng = await HarnMem.open({ harness: "cli", cwd, home, project: "proj", autoExtract: false, ...options });
  return { root, home, cwd, eng };
}

test("write -> read -> search roundtrip with Chinese content", async () => {
  const { eng } = await fresh();
  const res = await eng.write({
    type: "project",
    title: "检索方案：纯 JS BM25F",
    description: "默认检索使用纯 JS BM25F，不引入向量库",
    content: "决定使用纯 JS BM25F + CJK bigram 做默认检索。Why: 零依赖。How to apply: 新检索逻辑必须走索引模块。",
    tags: ["检索", "决策"],
  });
  assert.equal(res.action, "NEW");
  const read = await eng.read(res.id);
  assert.equal(read?.record.title, "检索方案：纯 JS BM25F");
  const search = await eng.search({ query: "用的是纯 JS 检索吗", limit: 5 });
  assert.equal(search.results[0]?.id, res.id);
  assert.ok(search.results[0].score > 0);
});

test("duplicate write is skipped", async () => {
  const { eng } = await fresh();
  const payload = {
    type: "project",
    title: "Database choice",
    description: "Use node:sqlite as an optional acceleration layer",
    content: "Pure JS index by default; node:sqlite FTS5 is feature-detected and optional.",
  };
  const first = await eng.write(payload);
  const second = await eng.write(payload);
  assert.equal(first.action, "NEW");
  assert.equal(second.action, "SKIP");
  assert.equal(second.id, first.id);
});

test("conflicting values under same topic supersede the old record", async () => {
  const { eng } = await fresh();
  const old = await eng.write({
    type: "project",
    title: "Service port configuration",
    description: "The backend service listens on port 8080",
    content: "The backend dev server port is set to 8080 for local debugging.",
    tags: ["config"],
  });
  const next = await eng.write({
    type: "project",
    title: "Service port configuration",
    description: "The backend service listens on port 9090",
    content: "The backend dev server port is changed to 9090 to avoid conflicts with other local services.",
    tags: ["config"],
  });
  assert.equal(next.action, "SUPERSEDE", `expected supersede, got ${next.action}`);
  assert.deepEqual(next.superseded, [old.id]);
  const search = await eng.search({ query: "backend port", limit: 5 });
  assert.equal(search.results[0]?.id, next.id);
  const read = await eng.read(old.id, { includeHistory: true });
  assert.equal(read?.record.status, "superseded");
  assert.equal(read?.record.supersededBy, next.id);
});

test("context snapshot is byte-stable until dirty", async () => {
  const { eng } = await fresh();
  await eng.write({ type: "user", title: "Preference: Chinese UI", description: "User asked for a Chinese interface", content: "Use Chinese for all UI text." });
  const first = await eng.sessionStart({ sessionId: "s1" });
  const second = await eng.ensureContext();
  assert.equal(first.text, second.text);
  const write = await eng.write({ type: "project", title: "New decision", description: "A new decision", content: "A new decision memory used to invalidate the snapshot." });
  const third = await eng.ensureContext();
  assert.notEqual(first.text, third.text);
  assert.ok(third.text.includes("New decision"));
  assert.equal(third.reason, "memory_write");
  void write;
});

test("search abstains on unrelated query and filters project scope", async () => {
  const { root, home, eng } = await fresh();
  const other = await HarnMem.open({ harness: "cli", cwd: join(root, "work", "other"), home, project: "other", autoExtract: false });
  const otherRec = await other.write({ type: "project", title: "Other project architecture", description: "Private architecture decision of the other project", content: "The other project uses event sourcing." });
  const mine = await eng.write({ type: "project", title: "This project architecture", description: "proj uses a plugin architecture", content: "proj adopts a plugin-based architecture." });
  assert.equal(otherRec.action, "NEW");
  const r = await eng.search({ query: "architecture", limit: 5 });
  assert.ok(!r.results.some((h) => h.id === otherRec.id), "cross-project leak");
  assert.ok(r.results.some((h) => h.id === mine.id));
  const nonsense = await eng.search({ query: "quantum gravitational wave dispersion relation", limit: 5 });
  assert.equal(nonsense.abstained, true);
  assert.equal(nonsense.results.length, 0);
});

test("forget -> restore keeps the record recoverable", async () => {
  const { eng } = await fresh();
  const rec = await eng.write({ type: "project", title: "Temporary conclusion", description: "A conclusion to delete", content: "This memory is moved to trash and then restored." });
  const forgot = await eng.forget(rec.id);
  assert.equal(forgot.ok, true);
  assert.equal(forgot.mode, "trash");
  assert.equal(await eng.read(rec.id), null);
  const restored = await eng.restore(rec.id);
  assert.equal(restored.ok, true);
  const back = await eng.read(rec.id);
  assert.equal(back?.record.title, "Temporary conclusion");
});

test("importRecords materializes explicit ids and timestamps", async () => {
  const { eng } = await fresh();
  const imported = await eng.importRecords([
    {
      id: "mem_imported0000000000000001",
      type: "reference",
      scope: "user",
      title: "Imported reference entry",
      description: "Entry migrated from another harness",
      content: "Migrated content with provenance.",
      created: 1700000000000,
      updated: 1700000000000,
      provenance: ["import:test"],
    },
  ]);
  assert.deepEqual(imported.ids, ["mem_imported0000000000000001"]);
  const read = await eng.read("mem_imported0000000000000001");
  assert.equal(read?.record.provenance[0], "import:test");
  assert.equal(read?.record.created, 1700000000000);
});

test("auto extraction adds memories once per session and skips when model wrote", async () => {
  const { eng, home } = await fresh({
    autoExtract: true,
    llm: async () => ({
      text: JSON.stringify({
        memories: [
          {
            type: "project",
            scope: "project",
            title: "Extracted decision",
            description: "Deployment approach agreed in the session",
            content: "Deploy with a local binary, no containers. Why: the environment is simple. How to apply: check this memory before adding a new deployment.",
            category: "decision",
            tags: ["deploy"],
            importance: 7,
            confidence: 0.9,
          },
        ],
      }),
    }),
    write: { autoExtract: true, minUserMessages: 2, minDigestChars: 20, minConfidence: 0, llmTimeoutMs: 5000 },
  });
  const messages = [
    { role: "user", text: "Let's settle the deployment approach: no containers." },
    { role: "assistant", text: "OK, deploy with a local binary then." },
    { role: "user", text: "Right, confirm that in memory." },
  ];
  const result = await eng.sessionEnd({ sessionId: "s1", messages });
  assert.equal(result.status, "done");
  assert.equal(result.added.length, 1);
  const search = await eng.search({ query: "deployment approach", limit: 3 });
  assert.ok(search.results.some((h) => h.title === "Extracted decision"));

  // The outcome (including every skip gate) is auditable for diagnostics.
  async function extractAudit() {
    const lines = (await readFile(join(home, "state", "audit.jsonl"), "utf8")).trim().split("\n");
    return lines.map((line) => JSON.parse(line)).filter((entry) => entry.kind === "extract");
  }
  const firstAudit = await extractAudit();
  assert.equal(firstAudit.length, 1);
  assert.equal(firstAudit[0].status, "done");
  assert.equal(firstAudit[0].added, 1);
  assert.equal(firstAudit[0].messages, 3);
  assert.equal(firstAudit[0].userMessages, 2);

  const second = await eng.sessionEnd({ sessionId: "s1", messages });
  assert.equal(second.status, "skipped");
  assert.equal(second.skipReason, "already_extracted");
  const secondAudit = await extractAudit();
  assert.equal(secondAudit.length, 2);
  assert.equal(secondAudit[1].status, "skipped");
  assert.equal(secondAudit[1].reason, "already_extracted");

  // A model that already wrote a memory in-session suppresses background extraction.
  const other = await fresh({
    autoExtract: true,
    llm: async () => ({ text: JSON.stringify({ memories: [] }) }),
    write: { autoExtract: true, minUserMessages: 1, minDigestChars: 10, minConfidence: 0, llmTimeoutMs: 5000 },
  });
  other.eng.noteModelWrite();
  const third = await other.eng.sessionEnd({ sessionId: "s2", messages });
  assert.equal(third.status, "skipped");
  assert.equal(third.skipReason, "model_wrote");
});

test("consolidation dry-run finds near duplicates without writing", async () => {
  const { eng } = await fresh();
  const a = await eng.write({ type: "project", title: "Build tool", description: "Bundle with esbuild", content: "Use esbuild for all builds; reasons: speed and zero config." });
  assert.equal(a.action, "NEW");
  await eng.importRecords([
    {
      id: "mem_c0nsolidation000000000001",
      type: "project",
      title: "Build tool",
      description: "Bundle with esbuild",
      content: "Use esbuild for all builds; reasons: speed and zero config.",
      created: 1700000000000,
      updated: 1700000000000,
    },
  ]);
  const dry = await eng.consolidate({ dryRun: true });
  assert.ok(dry.merged.length >= 1);
  assert.equal((await eng.read("mem_c0nsolidation000000000001"))?.record.status, "active");
});

test("stats reports shards and index state", async () => {
  const { eng } = await fresh();
  await eng.write({ type: "user", title: "Stats", description: "Stats test", content: "Stats test content." });
  const stats = await eng.stats();
  assert.equal(stats.home.endsWith("home"), true);
  assert.ok(stats.shards.some((s) => s.scope === "user"));
  assert.ok(stats.index.seq >= 1);
});

test("migrated source with nested migratedFrom survives disk roundtrip", async () => {
  const { eng } = await fresh();
  await eng.importRecords([
    {
      id: "mem_migrated00000000000000001",
      type: "feedback",
      scope: "user",
      title: "Migration source roundtrip",
      description: "Nested source.migratedFrom must survive the roundtrip",
      content: "Rule migrated from DSH: sort before truncating.",
      created: 1700000000000,
      updated: 1700000000000,
      source: {
        harness: "dsh",
        session: "sess-1",
        ts: 1700000000000,
        migratedFrom: { system: "dsh", path: "C:/memory/x.md", originalId: "orig-1" },
      },
    },
  ]);
  const read = await eng.read("mem_migrated00000000000000001");
  assert.equal(read?.record.source.harness, "dsh");
  assert.equal(read?.record.source.migratedFrom?.system, "dsh");
  assert.equal(read?.record.source.migratedFrom?.path, "C:/memory/x.md");
  assert.equal(read?.record.source.migratedFrom?.originalId, "orig-1");
});

test("extraction is idempotent across processes and still covers newer turns", async () => {
  const first = await fresh({
    autoExtract: true,
    llm: async () => ({ text: JSON.stringify({ memories: [] }) }),
    write: { autoExtract: true, minUserMessages: 2, minDigestChars: 20, minConfidence: 0, llmTimeoutMs: 5000 },
  });
  const messages = [
    { role: "user", text: "We agreed to use pnpm for every package in this repository." },
    { role: "assistant", text: "Understood." },
    { role: "user", text: "Please remember that decision forever." },
  ];
  const firstRun = await first.eng.sessionEnd({ sessionId: "s-cross", messages });
  assert.equal(firstRun.status, "done");
  await first.eng.close();

  // Same home, new process: the journal prefix must not hit the model again.
  let llmCalls = 0;
  const second = await HarnMem.open({
    harness: "cli",
    cwd: first.cwd,
    home: first.home,
    project: "proj",
    autoExtract: true,
    llm: async () => {
      llmCalls += 1;
      return { text: JSON.stringify({ memories: [] }) };
    },
    write: { autoExtract: true, minUserMessages: 2, minDigestChars: 20, minConfidence: 0, llmTimeoutMs: 5000 },
  });
  const repeat = await second.sessionEnd({ sessionId: "s-cross", messages: messages.slice(0, 2) });
  assert.equal(repeat.status, "skipped");
  assert.equal(repeat.skipReason, "already_extracted");
  assert.equal(llmCalls, 0);

  // Turns after the last extraction are not lost to the dedupe.
  const extended = [...messages, { role: "user", text: "Also run pnpm install before CI." }];
  const nextRun = await second.sessionEnd({ sessionId: "s-cross", messages: extended });
  assert.equal(nextRun.status, "done");
  assert.equal(llmCalls, 1);
  await second.close();
});

test("a too-short digest is reported as digest_too_small, not a silent done", async () => {
  const { eng } = await fresh({
    autoExtract: true,
    llm: async () => ({ text: JSON.stringify({ memories: [] }) }),
    write: { autoExtract: true, minUserMessages: 1, minDigestChars: 500, minConfidence: 0, llmTimeoutMs: 5000 },
  });
  const result = await eng.sessionEnd({
    sessionId: "s-small",
    messages: [
      { role: "user", text: "a" },
      { role: "user", text: "b" },
      { role: "user", text: "c" },
    ],
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.skipReason, "digest_too_small");
});

test("an LLM failure is reported as failed instead of a silent empty extraction", async () => {
  const { eng, home } = await fresh({
    autoExtract: true,
    llm: async () => {
      throw new Error("boom");
    },
    write: { autoExtract: true, minUserMessages: 1, minDigestChars: 20, minConfidence: 0, llmTimeoutMs: 5000 },
  });
  const result = await eng.sessionEnd({
    sessionId: "s-fail",
    messages: [
      { role: "user", text: `Remember the deployment approach we agreed on today: no containers, local binary only. ${"x".repeat(300)}` },
      { role: "user", text: `Also record that the backend port must stay 8080 for local debugging. ${"y".repeat(300)}` },
    ],
  });
  assert.equal(result.status, "failed");
  assert.match(result.error, /boom/);
  const audit = (await readFile(join(home, "state", "audit.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === "extract" && entry.session === "s-fail");
  assert.equal(audit.at(-1).status, "failed");
});
