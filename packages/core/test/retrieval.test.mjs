import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { HarnMem } from "../dist/index.js";

const roots = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function fresh(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "harnmem-retrieval-test-"));
  roots.push(root);
  const home = join(root, "home");
  const cwd = join(root, "work", "proj");
  const eng = await HarnMem.open({ harness: "cli", cwd, home, project: "proj", autoExtract: false, now: () => 1792454400000, ...options });
  return { root, home, cwd, eng };
}

test("link adjacency exposes out-links and backlinks", async () => {
  const { eng } = await fresh();
  const a = await eng.write({
    type: "project",
    title: "Core storage format",
    description: "Memories are persisted as Markdown with frontmatter",
    content: "Each memory is one Markdown file whose frontmatter carries id/type/scope.",
  });
  const b = await eng.write({
    type: "project",
    title: "Storage references",
    description: "The retrieval module references the storage format",
    content: "The retrieval module reads Markdown files directly and therefore depends on the core storage format.",
    links: [a.id],
  });
  assert.equal(a.action, "NEW");
  assert.equal(b.action, "NEW");

  const readA = await eng.read(a.id);
  assert.ok(readA, "A should exist");
  assert.ok(readA.backlinks.includes(b.id), `A backlinks should include B: ${JSON.stringify(readA.backlinks)}`);

  const readB = await eng.read(b.id);
  assert.ok(readB, "B should exist");
  assert.ok(!readB.backlinks.includes(a.id), "A does not link to B, so B has no backlink from A");
});

test("two-hop cross-shard diffusion surfaces linked user record from project seed", async () => {
  const { eng } = await fresh();
  const now = 1792454400000;
  // write() only keeps links that point inside the same shard, so cross-shard
  // edges (project -> user) come from imported records, exactly like the S5
  // eval corpus.
  const imported = await eng.importRecords([
    {
      id: "mem_user_lang",
      type: "user",
      scope: "user",
      title: "Answer language preference",
      description: "The user prefers answers in Simplified Chinese",
      content: "The user requires all answers in Simplified Chinese; code comments may stay in English.",
      importance: 6,
      created: now - 86400000,
      updated: now - 86400000,
    },
    {
      id: "mem_user_terms",
      type: "user",
      scope: "user",
      title: "Terminology preference",
      description: "Prefer Chinese terminology",
      content: "When explaining terms, prefer the Chinese term with the English original in parentheses.",
      links: ["mem_user_lang"],
      created: now - 86400000,
      updated: now - 86400000,
    },
    {
      id: "mem_proj_bm25f",
      type: "project",
      scope: "project",
      project: "proj",
      title: "Retrieval implementation: pure JS BM25F",
      description: "Default retrieval uses a pure JS BM25F additive index",
      content: "Decision: default retrieval uses pure JS BM25F with CJK bigrams; no vector store.",
      links: ["mem_user_lang"],
      created: now - 86400000,
      updated: now - 86400000,
    },
  ]);
  assert.deepEqual(imported.ids.sort(), ["mem_proj_bm25f", "mem_user_lang", "mem_user_terms"]);

  const search = await eng.search({ query: "BM25F pure JS retrieval implementation", scope: "all", limit: 10 });
  const ids = search.results.map((hit) => hit.id);
  assert.equal(search.abstained, false);
  assert.equal(ids[0], "mem_proj_bm25f", "seed must stay first");
  assert.ok(ids.includes("mem_user_lang"), `hop-1 user record should surface: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("mem_user_terms"), `hop-2 user record should surface: ${JSON.stringify(ids)}`);

  // The project-scoped view does not load the user shard, so the same link
  // cannot leak cross-scope records into a strictly project-scoped search.
  const projectOnly = await eng.search({ query: "BM25F pure JS retrieval implementation", scope: "project", limit: 10 });
  assert.ok(!projectOnly.results.map((hit) => hit.id).includes("mem_user_lang"));
});

test("MMR pool cap keeps the highest scoring candidate first", async () => {
  const { eng } = await fresh();
  const now = 1792454400000;
  const drafts = [];
  for (let i = 0; i < 200; i++) {
    drafts.push({
      id: `mem_draft_${String(i).padStart(3, "0")}`,
      type: "project",
      scope: "project",
      project: "proj",
      title: `Cache strategy draft v${i}`,
      description: `Intermediate cache strategy draft number ${i}`,
      content: `Intermediate discussion of the cache strategy, draft ${i}, not final.`,
      importance: 10,
      created: now - 86400000,
      updated: now - 86400000,
    });
  }
  const imported = await eng.importRecords(drafts);
  assert.equal(imported.ids.length, 200);
  const gold = await eng.write({
    type: "project",
    title: "Cache plan: frontmatter summary + lazy loading",
    description: "Final cache strategy decision: summaries stay resident, bodies load lazily",
    content: "Final decision: cache frontmatter summaries and load bodies lazily.",
  });
  assert.equal(gold.action, "NEW");
  const search = await eng.search({ query: "cache strategy final decision frontmatter lazy loading", limit: 10 });
  assert.equal(search.abstained, false);
  assert.equal(search.results[0]?.id, gold.id);
});

test("lex calibration separates an exact rare-token match from strong distractors", async () => {
  const { eng } = await fresh();
  const now = 1792454400000;
  const distractors = [];
  for (let i = 0; i < 12; i++) {
    distractors.push(`mem_arch_${i}`);
  }
  await eng.importRecords(
    distractors.map((id, i) => ({
      id,
      type: "project",
      scope: "project",
      project: "proj",
      title: `Architecture design draft v${i}`,
      description: `System architecture design discussion number ${i}`,
      content: `System architecture design discussion ${i}, focused on maintainability.`,
      importance: 10,
      created: now - 86400000,
      updated: now - 3600000, // fresher than gold
    })),
  );
  const gold = await eng.write({
    type: "project",
    title: "Zeta Protocol layered architecture final decision",
    description: "Adopt Zeta Protocol as the layering boundary",
    content: "Final decision: Zeta Protocol is the layering boundary; cross-layer calls are forbidden.",
    importance: 2,
  });
  assert.equal(gold.action, "NEW");
  const search = await eng.search({ query: "architecture layering boundary Zeta Protocol", limit: 10, debug: true });
  assert.equal(search.abstained, false);
  const ids = search.results.map((hit) => hit.id);
  assert.equal(ids[0], gold.id, `gold should rank first: ${JSON.stringify(ids)}`);
  const goldHit = search.results.find((hit) => hit.id === gold.id);
  const bestDistractor = search.results
    .filter((hit) => distractors.includes(hit.id))
    .sort((a, b) => b.parts.lex - a.parts.lex)[0];
  assert.ok(goldHit, "gold hit present");
  assert.ok(bestDistractor, "a distractor hit present");
  assert.ok(goldHit.parts.lex > bestDistractor.parts.lex, "gold lex must exceed distractor lex");
});
