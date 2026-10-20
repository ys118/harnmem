// Cross-harness S9 long-tail benchmark for @harnmem/core retrieval.
//
// Run: node spikes/core-bench/bench.mjs
// Prints one JSON object: importMs, coldFirstQueryMs, warm p50/p95/max,
// recall@10, and the shard/index overhead from stats().
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const corpus = join(repo, "evals", "corpora", "S9_longtail");

function readJsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function toImportRecord(r) {
  return {
    id: r.id,
    type: r.type,
    category: r.category ?? "decision",
    scope: r.scope,
    project: r.project ?? undefined,
    title: r.title,
    description: r.description,
    content: r.content ?? "",
    tags: r.tags ?? [],
    entities: r.entities ?? [],
    importance: r.importance ?? 6,
    confidence: r.confidence ?? 0.9,
    pinned: !!r.pinned,
    status: r.status ?? "active",
    created: r.created,
    updated: r.updated ?? r.created,
    validFrom: r.valid_from ?? r.validFrom ?? r.created,
    validTo: r.valid_to ?? r.validTo ?? null,
    lastUsed: r.last_used ?? r.lastUsed ?? undefined,
    usedCount: r.used_count ?? r.usedCount ?? 0,
    links: r.links ?? [],
    supersedes: r.supersedes ?? [],
    supersededBy: r.superseded_by ?? r.supersededBy ?? null,
    source: r.source ?? { harness: "cli", ts: r.created },
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const manifest = JSON.parse(readFileSync(join(corpus, "manifest.json"), "utf8"));
const memories = readJsonl(join(corpus, "memories.jsonl"));
const queries = readJsonl(join(corpus, "queries.jsonl"));
const fixedNow = manifest.now ?? 1792454400000;

const { HarnMem } = await import(pathToFileURL(join(repo, "packages", "core", "dist", "index.js")).href);
const home = await mkdtemp(join(tmpdir(), "harnmem-bench-"));

try {
  const eng = await HarnMem.open({
    harness: "cli",
    cwd: repo,
    home,
    project: "proj-alpha",
    autoExtract: false,
    now: () => fixedNow,
  });

  const t0 = performance.now();
  const imported = await eng.importRecords(memories.map(toImportRecord));
  const importMs = performance.now() - t0;

  const runQuery = async (q) => {
    const started = performance.now();
    const result = await eng.search({
      query: q.query,
      scope: q.scope ?? "all",
      project: q.project ?? undefined,
      limit: q.limit ?? 10,
    });
    return { ms: performance.now() - started, ids: result.results.map((hit) => hit.id), abstained: result.abstained };
  };

  const cold = await runQuery(queries[0]); // includes first index build

  // Warm the caches on a few queries before measuring, and force each project's
  // shard index to build once so lazy per-shard builds don't pollute "warm" p95.
  for (const q of queries.slice(0, 5)) await runQuery(q);
  for (const project of new Set(queries.map((q) => q.project).filter(Boolean))) {
    await eng.search({ query: queries[0].query, scope: "project", project, limit: 5 });
  }

  const latencies = [];
  let recallSum = 0;
  let goldTotal = 0;
  let abstained = 0;
  for (const q of queries) {
    const run = await runQuery(q);
    latencies.push(run.ms);
    if (run.abstained) abstained++;
    const gold = q.gold_ids ?? [];
    goldTotal += gold.length;
    const hitSet = new Set(run.ids);
    recallSum += gold.filter((id) => hitSet.has(id)).length;
  }
  latencies.sort((a, b) => a - b);
  const stats = await eng.stats();
  const totalBytes = stats.shards.reduce((sum, shard) => sum + shard.bytes, 0);

  console.log(
    JSON.stringify(
      {
        records: imported.ids.length,
        importMs: Number(importMs.toFixed(1)),
        coldFirstQueryMs: Number(cold.ms.toFixed(1)),
        warmP50Ms: Number(percentile(latencies, 50).toFixed(2)),
        warmP95Ms: Number(percentile(latencies, 95).toFixed(2)),
        warmMaxMs: Number(percentile(latencies, 100).toFixed(2)),
        recall10: Number((goldTotal === 0 ? 0 : recallSum / goldTotal).toFixed(4)),
        abstained,
        queries: queries.length,
        shards: stats.shards.length,
        storeBytes: totalBytes,
        indexBytes: stats.index.sizeBytes,
        indexOverhead: stats.index.overhead,
        indexBuildMs: stats.index.builtAt ? null : null,
      },
      null,
      2,
    ),
  );
  await eng.close();
} finally {
  await rm(home, { recursive: true, force: true });
}
