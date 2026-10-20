import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnMem } from "../dist/index.js";

const home = await mkdtemp(join(tmpdir(), "harnmem-smoke-"));
const cwd = join(home, "work", "demo");
process.env.HARNMEM_HOME = home;

const e = await HarnMem.open({ harness: "cli", cwd, home, project: "demo-project", autoExtract: false });
console.log("info", e.info());

const a = await e.write({
  type: "user",
  title: "Preference: Chinese UI",
  description: "User asked for all UI copy in Chinese",
  content: "The user explicitly wants every user-visible string in the harnmem plugin to be Chinese. Why: reading speed. How to apply: write new UI copy in Chinese first.",
  tags: ["preference", "language"],
  pinned: true,
});
console.log("write1", a.action, a.id);

const b = await e.write({
  type: "project",
  title: "Project decision: use pure JS BM25",
  description: "harnmem retrieval defaults to pure JS BM25, no embeddings",
  content: "Decision: default retrieval uses pure JS BM25F + CJK bigrams, no embeddings or sqlite. Reason: zero dependencies, cross-harness.",
  tags: ["decision", "retrieval"],
});
console.log("write2", b.action, b.id);

const dup = await e.write({
  type: "project",
  title: "Project decision: use pure JS BM25",
  description: "harnmem retrieval defaults to pure JS BM25, no embeddings",
  content: "Decision: default retrieval uses pure JS BM25F + CJK bigrams, no embeddings or sqlite. Reason: zero dependencies, cross-harness.",
  tags: ["decision", "retrieval"],
});
console.log("writeDup", dup.action, dup.id);

const ctx = await e.sessionStart({ sessionId: "s1" });
console.log("context bytes", Buffer.byteLength(ctx.text, "utf8"), "ids", ctx.ids.length, "reason", ctx.reason);
console.log("---context---\n" + ctx.text + "\n---");

const search = await e.search({ query: "what retrieval approach is used", limit: 5, debug: true });
console.log("search results", search.results.length, "abstained", search.abstained, "total", search.total, "candidates", search.debug?.candidateCount);
for (const h of search.results) console.log(" -", h.id, h.title, h.score.toFixed(3), "lex=", h.parts?.lex.toFixed(3), "pin=", h.pinned);

const co = await e.search({ query: "user preference Chinese", limit: 3 });
console.log("search2", co.results.map((h) => h.title));

const read = await e.read(b.id);
console.log("read", read?.record.title, "backlinks", read?.backlinks.length);

const forget = await e.forget(b.id);
console.log("forget", forget);
const restore = await e.restore(b.id);
console.log("restore", restore);

const stats = await e.stats();
console.log("stats shards", JSON.stringify(stats.shards), "index", JSON.stringify(stats.index));

const report = await e.consolidate({ dryRun: false });
console.log("consolidate", JSON.stringify(report));

await e.close();
await rm(home, { recursive: true, force: true });
console.log("SMOKE_DONE");
