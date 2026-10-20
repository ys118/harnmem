#!/usr/bin/env node
/**
 * harnmem deterministic eval runner.
 *
 *   node evals/run.mjs                     # S1..S12, engine auto (core if built, else js ref)
 *   node evals/run.mjs --suite S1,S3,S9    # subset
 *   node evals/run.mjs --gate              # exit 1 when gates fail
 *   node evals/run.mjs --report            # write evals/results/eval-report.md
 *   node evals/run.mjs --ablations         # A0..A5 ladder over S1,S2,S3,S5,S7
 *   node evals/run.mjs --engine js|core --scale ... (scale only regenerates corpora)
 *
 * Deterministic: fixed corpora + frozen now() + no wall-clock in metrics. The
 * results file records a timestamp, but every metric number is a pure function
 * of corpus bytes and engine config.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeSuiteMetrics, aggregate, fmt, mean, quantile } from "./lib/metrics.mjs";
import { openStore, ABLATIONS, BUDGET } from "./lib/store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // <repo>/evals
const EVALS = HERE;
const ROOT = resolve(HERE, "..");
const CORPORA = join(EVALS, "corpora");
const RESULTS = join(EVALS, "results");
const DATA = join(EVALS, "data");
const NOW = Date.UTC(2026, 9, 20, 0, 0, 0);
const ALL_SUITES = [
  "S1_profile",
  "S2_project",
  "S3_temporal",
  "S4_forget",
  "S5_multihop",
  "S6_abstain",
  "S7_distractor",
  "S8_bilingual",
  "S9_longtail",
  "S10_consolidate",
  "S11_noisy_text",
  "S12_budget",
];
const ABLATION_SUITES = ["S1_profile", "S2_project", "S3_temporal", "S5_multihop", "S7_distractor"];

// ------------------------------------------------------------------- utils
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith("--")) {
      const [k, inline] = x.slice(2).split("=");
      const v = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
      a[k] = v;
    } else a._.push(x);
  }
  return a;
}
const readJsonl = (p) => {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};
// Global CLI args (set in main) so suite runners can honour --queries-cap.
let CLI = {};
const loadSynonyms = () => {
  const map = new Map();
  const p = join(DATA, "synonyms.zh.tsv");
  if (!existsSync(p)) return map;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [a, b] = t.split("\t");
    if (!a || !b) continue;
    if (!map.has(a)) map.set(a, []);
    if (!map.has(b)) map.set(b, []);
    map.get(a).push(b);
    map.get(b).push(a);
  }
  return map;
};
const ensureCorpora = (args) => {
  if (args.regen || !existsSync(join(CORPORA, "manifest.json"))) {
    const genArgs = ["evals/gen/generate.mjs"];
    if (args.scale) genArgs.push("--scale", String(args.scale));
    const r = spawnSync(process.execPath, genArgs, { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
};
const loadManifest = () => JSON.parse(readFileSync(join(CORPORA, "manifest.json"), "utf8"));
const tmpHome = (suite) => join(EVALS, ".tmp", `${suite}-${Date.now().toString(36)}`);
const rmDir = (p) => rmSync(p, { recursive: true, force: true });

// ------------------------------------------------------------------- suite runners
async function runRetrievalSuite({ suite, manifest, engine, ablation, synonyms }) {
  const dir = join(CORPORA, suite);
  const memories = readJsonl(join(dir, "memories.jsonl"));
  const allQueries = readJsonl(join(dir, "queries.jsonl"));
  const cap = Number(CLI["queries-cap"] ?? 0);
  // Stratified cap: take evenly-spaced queries so language/kind mixes and the
  // S9 unique-token / topical split stay representative of the full suite.
  const queries =
    cap > 0 && cap < allQueries.length
      ? allQueries.filter((_, i) => i % Math.ceil(allQueries.length / cap) === 0).slice(0, cap)
      : allQueries;
  const home = tmpHome(suite);
  mkdirSync(home, { recursive: true });
  const store = await openStore({ engine, ablation, home, project: null, now: NOW });
  if (typeof store.setSynonyms === "function") store.setSynonyms(synonyms);
  const imp = await store.importRecords(memories);
  // explicit forgets are applied once, before queries (S4)
  const forgetIds = [...new Set(queries.flatMap((q) => q.forget_ids ?? []))];
  if (forgetIds.length && store.capabilities?.forget !== false) await store.forget(forgetIds);
  // warmup: absorbs lazy index build / cold caches; not measured
  await store.search("warmup query", { limit: 3, scope: "all" });

  const projOf = new Map(memories.map((m) => [m.id, m.project ?? null]));
  const results = [];
  for (const q of queries) {
    const t0 = performance.now();
    const res = await store.search(q.query, {
      scope: q.scope ?? "all",
      project: q.project ?? undefined,
      limit: q.limit ?? 10,
      includeHistory: !!q.include_history,
      ...(q.as_of ? { asOf: q.as_of } : {}),
    });
    const latencyMs = performance.now() - t0;
    const top10 = res.ids.slice(0, 10);
    results.push({
      qid: q.qid,
      suite,
      ids: res.ids,
      abstained: res.abstained,
      latencyMs,
      tokensEstimate: 0,
      gold: q.gold_ids ?? [],
      goldPinned: !!q.pinned_gold,
      forbidden: q.forbidden_ids ?? [],
      noise: q.noise_ids ?? [],
      expectAbstain: !!q.expect_abstain,
      lang: q.lang ?? "zh",
      kinds: q.kinds ?? ["normal"],
      foreignHits10: q.project ? top10.filter((id) => projOf.get(id) && projOf.get(id) !== q.project).length : undefined,
    });
  }
  const row = computeSuiteMetrics(suite, results);
  row.memories = memories.length;
  row.queries = results.length;
  if (queries.length !== allQueries.length) row.queriesCapped = `${queries.length}/${allQueries.length}`;
  row.importMs = Math.round(imp.ms * 100) / 100;
  if (typeof store.stats === "function") {
    try {
      const st = await store.stats();
      row.store = st.store;
      row.indexBytes = st.indexBytes;
      row.bodyBytes = st.bodyBytes;
      row.indexOverhead = Math.round((st.overhead ?? 0) * 1000) / 1000;
      row.indexOverheadContent = Math.round((st.overhead_content ?? 0) * 1000) / 1000;
    } catch {
      /* stats optional */
    }
  }
  // S10: consolidation correctness from the engine's own report
  let consolidation = null;
  if (suite === "S10_consolidate" && typeof store.consolidate === "function") {
    const labels = readJsonl(join(dir, "labels.jsonl"));
    try {
      const rep = await store.consolidate({ mechanicalOnly: true, dryRun: false });
      const parent = new Map();
      const find = (x) => {
        let r = x;
        while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
        return r;
      };
      for (const m of rep?.merged ?? []) {
        parent.set(m.into, m.into);
        for (const f of m.from) parent.set(f, m.into);
      }
      const same = (a, b) => find(a) === find(b);
      const dup = labels.filter((l) => l.kind === "dup");
      const dis = labels.filter((l) => l.kind === "distinct");
      const dedupRate = dup.length ? dup.filter((l) => same(l.a, l.b)).length / dup.length : null;
      const overMerge = dis.length ? dis.filter((l) => same(l.a, l.b)).length / dis.length : null;
      row.dedup_rate = Math.round(dedupRate * 1000) / 1000;
      row.over_merge = Math.round(overMerge * 1000) / 1000;
      row.merged_groups = rep?.merged?.length ?? 0;
      consolidation = { merged: rep?.merged?.length ?? 0, dedupRate, overMerge };
    } catch (err) {
      row.dedup_rate = null;
      row.over_merge = null;
      row.consolidate_error = String(err.message ?? err);
    }
  }
  await store.close?.();
  rmDir(home);
  return { row, results, consolidation };
}

async function runContextSuite({ suite, manifest, engine, ablation }) {
  const dir = join(CORPORA, suite);
  const s12 = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const poolDir = join(CORPORA, s12.pool);
  const memories = readJsonl(join(poolDir, "memories.jsonl"));
  const pinnedIds = s12.pinnedIds ?? [];
  const home = tmpHome(suite);
  mkdirSync(home, { recursive: true });
  const store = await openStore({ engine, ablation, home, project: null, now: NOW });
  const imp = await store.importRecords(memories);
  const repeats = s12.repeats ?? 20;
  const lat = [];
  const tokens = [];
  let kept = 0;
  let lastIds = [];
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    const ctx = await store.buildContext("session_start");
    lat.push(performance.now() - t0);
    tokens.push(ctx.tokensEstimate ?? Math.round((ctx.text?.length ?? 0) / 2.8));
    lastIds = ctx.ids ?? [];
    if (i === repeats - 1) {
      kept = pinnedIds.filter((id) => lastIds.includes(id)).length;
    }
  }
  const row = {
    suite,
    nQueries: 0,
    nGold: 0,
    recall_at_1: null,
    recall_at_3: null,
    recall_at_10: null,
    precision_at_1: null,
    mrr: null,
    ndcg_at_10: null,
    both_recall_at_10: null,
    abstain_fp: null,
    forbidden_leak_10: null,
    forbidden_leak_3: null,
    noise_in_top10: null,
    latency_p50_ms: Math.round(quantile(lat, 0.5) * 100) / 100,
    latency_p95_ms: Math.round(quantile(lat, 0.95) * 100) / 100,
    latency_max_ms: Math.round(Math.max(...lat) * 100) / 100,
    token_cost_p95: Math.round(quantile(tokens, 0.95)),
    pinned_kept: pinnedIds.length ? Math.round((kept / pinnedIds.length) * 1000) / 1000 : null,
    memories: memories.length,
    importMs: Math.round(imp.ms * 100) / 100,
    contextEntries: lastIds.length,
  };
  await store.close?.();
  rmDir(home);
  return { row };
}

// ------------------------------------------------- S10 write-time action suite
// Measures the engine's actual dedupe/consolidation decision per write, then
// the retrieval consequences of those decisions (new value supersedes old,
// old value visible only with includeHistory). The corpus labels every variant
// with its intended action (SKIP|MERGE|SUPERSEDE|LINK|NEW).
async function runActionSuite({ suite, manifest, engine, synonyms }) {
  const dir = join(CORPORA, suite);
  const memories = readJsonl(join(dir, "memories.jsonl"));
  const allQueries = readJsonl(join(dir, "queries.jsonl"));
  const labels = readJsonl(join(dir, "labels.jsonl"));
  const cap = Number(CLI["queries-cap"] ?? 0);
  const queries = cap > 0 && cap < allQueries.length ? allQueries.slice(0, cap) : allQueries;
  const home = tmpHome(suite);
  mkdirSync(home, { recursive: true });
  const store = await openStore({ engine, ablation: "A5", home, project: null, now: NOW });
  if (typeof store.setSynonyms === "function") store.setSynonyms(synonyms);
  const imp = await store.importRecords(memories);
  const canWrite = store.capabilities?.write !== false;
  if (!canWrite) throw new Error(`store ${store.name} has no write() — S10 write-time suite needs the core engine`);
  await store.search("warmup query", { limit: 3, scope: "all" });

  const confusion = {};
  const mismatches = [];
  const supersedeCases = [];
  let writeMs = 0;
  for (const label of labels) {
    const t0 = performance.now();
    const res = await store.write(label.input);
    writeMs += performance.now() - t0;
    const expected = label.expect_action;
    const actual = String(res.action ?? "").toUpperCase();
    confusion[expected] ??= {};
    confusion[expected][actual] = (confusion[expected][actual] ?? 0) + 1;
    const idOk =
      expected === "SKIP" || expected === "MERGE"
        ? res.id === label.canonical_id
        : expected === "SUPERSEDE"
          ? res.id !== label.canonical_id && (res.superseded ?? []).includes(label.canonical_id)
          : res.id !== label.canonical_id;
    if (actual !== expected || !idOk) {
      mismatches.push({
        group: label.group,
        kind: label.kind,
        expected,
        actual,
        idOk,
        own_sim: label.own_sim,
        own_hamming: label.own_hamming,
      });
    }
    if (expected === "SUPERSEDE") supersedeCases.push({ label, newId: res.id });
  }
  const actionCorrect = labels.length - mismatches.length;
  const overMergeCandidates = labels.filter((l) => l.expect_action === "NEW" || l.expect_action === "LINK");
  const overMerged = mismatches.filter(
    (m) => (m.expected === "NEW" || m.expected === "LINK") && (m.actual === "MERGE" || m.actual === "SUPERSEDE"),
  );

  // supersede semantics: new value active + old value history-only
  let newRecall = 0;
  let oldHistoryRecall = 0;
  let oldDefaultLeak = 0;
  for (const { label, newId } of supersedeCases) {
    const qNew = await store.search(label.query_new, { scope: "user", limit: 10, includeHistory: false });
    if (qNew.ids.includes(newId)) newRecall++;
    const qOldHist = await store.search(label.query_old, { scope: "user", limit: 10, includeHistory: true });
    if (qOldHist.ids.includes(label.canonical_id)) oldHistoryRecall++;
    const qOldDefault = await store.search(label.query_old, { scope: "user", limit: 10, includeHistory: false });
    if (qOldDefault.ids.includes(label.canonical_id)) oldDefaultLeak++;
  }

  // generic retrieval queries (stable groups + history-mode queries)
  const results = [];
  for (const q of queries) {
    const t0 = performance.now();
    const res = await store.search(q.query, {
      scope: q.scope ?? "all",
      project: q.project ?? undefined,
      limit: q.limit ?? 10,
      includeHistory: !!q.include_history,
    });
    results.push({
      qid: q.qid,
      suite,
      ids: res.ids,
      abstained: res.abstained,
      latencyMs: performance.now() - t0,
      tokensEstimate: 0,
      gold: q.gold_ids ?? [],
      forbidden: q.forbidden_ids ?? [],
      noise: q.noise_ids ?? [],
      expectAbstain: !!q.expect_abstain,
      lang: q.lang ?? "zh",
      kinds: q.kinds ?? ["normal"],
    });
  }
  const row = computeSuiteMetrics(suite, results);
  row.memories = memories.length;
  row.queries = results.length;
  row.labels = labels.length;
  row.importMs = Math.round(imp.ms * 100) / 100;
  row.writeMs = Math.round(writeMs * 100) / 100;
  row.action_accuracy = labels.length ? Math.round((actionCorrect / labels.length) * 1000) / 1000 : null;
  row.action_confusion = confusion;
  row.action_mismatches = mismatches.length;
  row.action_mismatch_detail = mismatches.slice(0, 20);
  row.over_merge = overMergeCandidates.length ? Math.round((overMerged.length / overMergeCandidates.length) * 1000) / 1000 : 0;
  row.over_merge_n = overMerged.length;
  row.supersede_new_recall = supersedeCases.length ? Math.round((newRecall / supersedeCases.length) * 1000) / 1000 : null;
  row.superseded_history_recall = supersedeCases.length ? Math.round((oldHistoryRecall / supersedeCases.length) * 1000) / 1000 : null;
  row.superseded_default_leak = supersedeCases.length ? Math.round((oldDefaultLeak / supersedeCases.length) * 1000) / 1000 : null;
  if (typeof store.stats === "function") {
    try {
      const st = await store.stats();
      row.store = st.store;
      row.indexBytes = st.indexBytes;
      row.bodyBytes = st.bodyBytes;
      row.indexOverhead = Math.round((st.overhead ?? 0) * 1000) / 1000;
    } catch {
      /* stats optional */
    }
  }
  await store.close?.();
  rmDir(home);
  return { row, results };
}

// ------------------------------------------------------------------- gates
const cmp = (actual, op, value) => {
  if (actual === null || actual === undefined) return false;
  switch (op) {
    case ">=":
      return actual >= value;
    case "<=":
      return actual <= value;
    case "==":
      return Math.abs(actual - value) < 1e-9;
    case ">":
      return actual > value;
    case "<":
      return actual < value;
    default:
      throw new Error(`bad gate op ${op}`);
  }
};
const PATH = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
function evaluateGates(gates, rows, overall) {
  const bySuite = new Map(rows.map((r) => [r.suite, r]));
  const list = [];
  for (const g of gates.suite ?? []) {
    const actual = bySuite.get(g.suite)?.[g.metric] ?? null;
    const skipped = actual === null;
    list.push({ ...g, scope: "suite", severity: g.severity ?? "hard", actual, skipped, pass: !skipped && cmp(actual, g.op, g.value) });
  }
  for (const g of gates.overall ?? []) {
    const actual = g.metric === "zh_en_recall_gap" ? overall.zh_en_recall_gap : PATH(overall, g.metric);
    const skipped = actual === null;
    list.push({ ...g, scope: "overall", severity: g.severity ?? "hard", actual, skipped, pass: !skipped && cmp(actual, g.op, g.value) });
  }
  for (const g of gates.perf ?? []) {
    const actual = PATH(overall, g.metric);
    const skipped = actual === null;
    list.push({ ...g, scope: "perf", severity: g.severity ?? "hard", actual, skipped, pass: !skipped && cmp(actual, g.op, g.value) });
  }
  return list;
}

// ------------------------------------------------------------------- printing
function printTable(rows) {
  const cols = [
    ["suite", 16, (r) => r.suite],
    ["mem", 6, (r) => String(r.memories ?? "-")],
    ["nQ", 4, (r) => String(r.nQueries ?? "-")],
    ["R@1", 6, (r) => fmt(r.recall_at_1, 3)],
    ["R@3", 6, (r) => fmt(r.recall_at_3, 3)],
    ["R@10", 6, (r) => fmt(r.recall_at_10, 3)],
    ["P@1", 6, (r) => fmt(r.precision_at_1, 3)],
    ["MRR", 6, (r) => fmt(r.mrr, 3)],
    ["nDCG", 6, (r) => fmt(r.ndcg_at_10, 3)],
    ["abstFP", 8, (r) => fmt(r.abstain_fp, 3)],
    ["leak10", 8, (r) => fmt(r.forbidden_leak_10, 3)],
    ["leak3", 7, (r) => fmt(r.forbidden_leak_3, 3)],
    ["noise", 7, (r) => fmt(r.noise_in_top10, 2)],
    ["both", 7, (r) => fmt(r.both_recall_at_10, 3)],
    ["p95ms", 8, (r) => fmt(r.latency_p95_ms, 2)],
    ["tok95", 6, (r) => (r.token_cost_p95 === null ? "-" : String(r.token_cost_p95))],
    ["extra", 22, (r) => {
      const parts = [];
      if (r.action_accuracy !== null && r.action_accuracy !== undefined) parts.push(`action=${fmt(r.action_accuracy, 3)}`);
      if (r.supersede_new_recall !== null && r.supersede_new_recall !== undefined) {
        parts.push(`supNew=${fmt(r.supersede_new_recall, 2)} supHist=${fmt(r.superseded_history_recall, 2)} supLeak=${fmt(r.superseded_default_leak, 2)}`);
      }
      if (r.dedup_rate !== null && r.dedup_rate !== undefined) parts.push(`dedup=${fmt(r.dedup_rate, 3)}`);
      if (r.over_merge !== null && r.over_merge !== undefined) parts.push(`over=${fmt(r.over_merge, 3)}`);
      if (r.pinned_kept !== null && r.pinned_kept !== undefined) parts.push(`pinKept=${fmt(r.pinned_kept, 3)}`);
      if (r.both_recall_at_10 !== null && r.both_recall_at_10 !== undefined) parts.push(`both=${fmt(r.both_recall_at_10, 3)}`);
      if (r.indexOverhead !== undefined) parts.push(`idx=${fmt(r.indexOverhead, 3)}`);
      if (r.zh_en_recall_gap !== null && r.zh_en_recall_gap !== undefined) parts.push(`gap=${fmt(r.zh_en_recall_gap, 3)}`);
      if (r.foreignHits10) parts.push(`scopeLeak=${fmt(r.foreignHits10, 2)}`);
      return parts.join(" ");
    }],
  ];
  console.log(cols.map(([h, w]) => h.padEnd(w)).join(""));
  console.log(cols.map(([h, w]) => "-".repeat(w)).join(" "));
  for (const r of rows) console.log(cols.map(([, w, f]) => String(f(r)).padEnd(w)).join(""));
}

function gateTable(gates) {
  const failed = gates.filter((g) => !g.skipped && !g.pass);
  const hard = failed.filter((g) => g.severity !== "advisory");
  const advisory = failed.filter((g) => g.severity === "advisory");
  const skipped = gates.filter((g) => g.skipped).length;
  const measured = gates.length - skipped;
  console.log(
    `\nGates: ${measured - failed.length}/${measured} passed` +
      (advisory.length ? `, ${advisory.length} advisory fail` : "") +
      (skipped ? ` (${skipped} skipped: suite not run)` : ""),
  );
  for (const g of gates) {
    const name = g.scope === "suite" ? `${g.suite}.${g.metric}` : `${g.scope}.${g.metric}`;
    const status = g.skipped ? "SKIP" : g.pass ? "PASS" : g.severity === "advisory" ? "ADVISORY" : "FAIL";
    console.log(`  ${status}  ${name.padEnd(42)} ${fmt(g.actual, 4).padStart(8)} ${g.op} ${g.value}`);
  }
  return { failed, hard, advisory };
}

function reportMarkdown({ rows, overall, gates, ablations, meta }) {
  const lines = [];
  lines.push("# harnmem retrieval-level eval report", "");
  lines.push(`- generated: ${new Date().toISOString()}`);
  lines.push(`- engine: **${meta.engine}** (${meta.store}) | corpus seed ${meta.seed} | generator ${meta.generatorVersion}`);
  lines.push(`- suites: ${rows.length} | queries: ${rows.reduce((a, r) => a + (r.nQueries || 0), 0)} | docs: ${rows.reduce((a, r) => a + (r.memories || 0), 0)}`);
  lines.push(`- numbers are **retrieval-level** (id-level recall/MRR/nDCG), not end-to-end generation quality.`);
  lines.push("");
  lines.push("## Per-suite metrics");
  lines.push("");
  lines.push("| suite | mem | q | R@1 | R@3 | R@10 | P@1 | MRR | nDCG@10 | abstFP | leak10 | p95 ms | action acc | over-merge | sup new | sup hist | sup default leak | pinned kept |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const f = (x, d = 3) => (x === null || x === undefined ? "—" : typeof x === "number" ? x.toFixed(d) : x);
  for (const r of rows) {
    lines.push(
      `| ${r.suite} | ${r.memories ?? "—"} | ${r.nQueries ?? 0} | ${f(r.recall_at_1)} | ${f(r.recall_at_3)} | ${f(r.recall_at_10)} | ${f(r.precision_at_1)} | ${f(r.mrr)} | ${f(r.ndcg_at_10)} | ${f(r.abstain_fp)} | ${f(r.forbidden_leak_10)} | ${f(r.latency_p95_ms, 2)} | ${f(r.action_accuracy)} | ${f(r.over_merge)} | ${f(r.supersede_new_recall)} | ${f(r.superseded_history_recall)} | ${f(r.superseded_default_leak)} | ${f(r.pinned_kept)} |`,
    );
  }
  lines.push("");
  const s10 = rows.find((r) => r.suite === "S10_consolidate" && r.action_confusion);
  if (s10) {
    lines.push("## S10 write-time action confusion (expected → actual)");
    lines.push("");
    const acts = ["NEW", "SKIP", "MERGE", "SUPERSEDE", "LINK"];
    lines.push(`| expected \\ actual | ${acts.join(" | ")} |`);
    lines.push(`|---|${acts.map(() => "---|").join("")}`);
    for (const exp of acts) {
      const row = s10.action_confusion[exp];
      if (!row) continue;
      lines.push(`| ${exp} | ${acts.map((a) => row[a] ?? 0).join(" | ")} |`);
    }
    lines.push("");
    lines.push(`- action accuracy: **${f(s10.action_accuracy)}** (${s10.labels ?? "?"} labelled writes, ${s10.action_mismatches ?? 0} mismatches)`);
    lines.push(`- semantic over-merge: **${f(s10.over_merge)}** (${s10.over_merge_n ?? 0} NEW/LINK writes wrongly merged/superseded)`);
    lines.push(`- supersede: new-value recall top10 ${f(s10.supersede_new_recall)} · old-value history recall ${f(s10.superseded_history_recall)} · old-value default leak ${f(s10.superseded_default_leak)}`);
    if (s10.action_mismatch_detail?.length) {
      lines.push("");
      lines.push("First mismatches (group, kind, expected→actual, canonical id matched?):");
      for (const m of s10.action_mismatch_detail.slice(0, 10)) {
        lines.push(`- group ${m.group} ${m.kind}: **${m.expected} → ${m.actual}** (idOk=${m.idOk}, sim=${f(m.own_sim, 2)}, hamming=${m.own_hamming})`);
      }
    }
    lines.push("");
  }
  lines.push("## Overall");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(overall, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Gates");
  lines.push("");
  lines.push("| gate | actual | threshold | pass |");
  lines.push("|---|---|---|---|");
  for (const g of gates) {
    const name = g.scope === "suite" ? `${g.suite}.${g.metric}` : `${g.scope}.${g.metric}`;
    lines.push(`| ${name} | ${f(g.actual, 4)} | ${g.op} ${g.value} | ${g.pass ? "PASS" : g.severity === "advisory" ? "ADVISORY" : "FAIL"} |`);
  }
  if (ablations) {
    lines.push("");
    lines.push("## Ablation ladder");
    lines.push("");
    lines.push("| ablation | " + ablations.suites.join(" R@10 | ") + " | macro R@10 | macro MRR |");
    lines.push("|---|" + ablations.suites.map(() => "---|").join("") + "---|---|");
    for (const a of ablations.rows) {
      lines.push(`| ${a.label} | ${ablations.suites.map((s) => f(a.suites[s]?.recall_at_10)).join(" | ")} | ${f(a.macro.recall_at_10)} | ${f(a.macro.mrr)} |`);
    }
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------- main
async function main() {
  const args = parseArgs(process.argv);
  CLI = args;
  ensureCorpora(args);
  const manifest = loadManifest();
  const engine = args.engine ?? "auto";
  const ablationsOnly = !!args.ablations && !args.suite && !args.full;
  const suiteNames = args.suite
    ? String(args.suite)
        .split(",")
        .map((s) => (ALL_SUITES.includes(s) ? s : ALL_SUITES.find((x) => x.startsWith(s))))
        .filter(Boolean)
    : ablationsOnly
      ? ABLATION_SUITES
      : ALL_SUITES;
  const synonyms = loadSynonyms();
  const started = Date.now();
  const rows = [];
  const perSuiteResults = {};

  console.log(`[eval] engine=${engine} ablation=A5 suites=${suiteNames.length} seed=${manifest.seed} gen=${manifest.generatorVersion}`);
  for (const suite of suiteNames) {
    const sm = manifest.suites[suite];
    if (!sm) {
      console.error(`[eval] unknown suite ${suite}`);
      continue;
    }
    const t0 = performance.now();
    let row;
    if (suite === "S10_consolidate") {
      const r = await runActionSuite({ suite, manifest, engine, synonyms });
      row = r.row;
      perSuiteResults[suite] = r.results;
    } else if (sm.kind === "context") {
      row = (await runContextSuite({ suite, manifest, engine, ablation: "A5" })).row;
    } else {
      const r = await runRetrievalSuite({ suite, manifest, engine, ablation: "A5", synonyms });
      row = r.row;
      perSuiteResults[suite] = r.results;
    }
    rows.push(row);
    console.log(`[eval] ${suite.padEnd(16)} done in ${Math.round(performance.now() - t0)}ms  R@10=${fmt(row.recall_at_10)}`);
  }

  // ---- overall
  const agg = aggregate(rows);
  const s9 = rows.find((r) => r.suite === "S9_longtail") ?? {};
  const s12 = rows.find((r) => r.suite === "S12_budget") ?? {};
  const s8 = rows.find((r) => r.suite === "S8_bilingual") ?? {};
  const s1s2 = rows.filter((r) => r.suite === "S1_profile" || r.suite === "S2_project");
  const overall = {
    ...agg.macro,
    macro: agg.macro,
    micro: agg.micro,
    recall_at_10_s1s2: s1s2.length
      ? Math.round((s1s2.reduce((a, r) => a + (r.recall_at_10 ?? 0), 0) / s1s2.length) * 10000) / 10000
      : null,
    zh_en_recall_gap: s8.zh_en_recall_gap ?? null,
    index_overhead: s9.indexOverhead ?? null,
    build_ms_10k: s9.importMs ?? null,
    latency_search_p95_ms: s9.latency_p95_ms ?? null,
    latency_inject_p95_ms: s12.latency_p95_ms ?? null,
    token_cost_p95: s12.token_cost_p95 ?? null,
    pinned_kept: s12.pinned_kept ?? null,
    suites: rows.map((r) => `${r.suite}:${fmt(r.recall_at_10)}`).join(" "),
  };

  // ---- ablations
  let ablations = null;
  const ablationSuites = args["ablation-suites"]
    ? String(args["ablation-suites"])
        .split(",")
        .map((s) => (ALL_SUITES.includes(s) ? s : ALL_SUITES.find((x) => x.startsWith(s))))
        .filter(Boolean)
    : ABLATION_SUITES;
  if (args.ablations) {
    console.log(`\n[eval] ablation ladder on ${ablationSuites.join(",")}`);
    ablations = { suites: [], rows: [] };
    for (const ab of Object.keys(ABLATIONS)) {
      const preset = ABLATIONS[ab];
      // A0 is a harness-only grep baseline; A2b needs core's synonyms toggle.
      if ((preset.jsOnly && engine !== "js") || (preset.coreOnly && engine !== "core")) continue;
      const abRows = [];
      for (const suite of ablationSuites) {
        const r = await runRetrievalSuite({ suite, manifest, engine, ablation: ab, synonyms });
        abRows.push(r.row);
      }
      const aggAb = aggregate(abRows);
      ablations.rows.push({ id: ab, label: ABLATIONS[ab].label, suites: Object.fromEntries(abRows.map((r) => [r.suite, r])), macro: aggAb.macro });
      console.log(`  ${ab} ${ABLATIONS[ab].label.padEnd(24)} macroR@10=${fmt(aggAb.macro.recall_at_10)} macroMRR=${fmt(aggAb.macro.mrr)}`);
    }
    ablations.suites = ablationSuites;
  }

  // ---- gates + output
  const gatesPath = join(EVALS, "gates.json");
  let gates = [];
  if (existsSync(gatesPath)) {
    const gatesDef = JSON.parse(readFileSync(gatesPath, "utf8"));
    gates = evaluateGates(gatesDef, rows, overall);
  }
  console.log("");
  printTable(rows);
  let failed = [];
  let advisory = [];
  let hard = [];
  if (gates.length) ({ failed, hard, advisory } = gateTable(gates));
  if (ablations) {
    console.log("\nAblation ladder (macro over " + ABLATION_SUITES.join(",") + ")");
    console.log("  ablation                         R@10   MRR    nDCG   P@1");
    for (const a of ablations.rows) {
      console.log(
        `  ${a.label.padEnd(30)} ${fmt(a.macro.recall_at_10)}  ${fmt(a.macro.mrr)}  ${fmt(a.macro.ndcg_at_10)}  ${fmt(a.macro.precision_at_1)}`,
      );
    }
  }

  // ---- results json (timestamped + latest)
  mkdirSync(RESULTS, { recursive: true });
  const meta = {
    ts: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    node: process.version,
    platform: process.platform,
    engine: engine === "auto" ? (rows[0]?.store?.startsWith("core") ? "core" : "js") : engine,
    store: rows[0]?.store ?? "unknown",
    seed: manifest.seed,
    generatorVersion: manifest.generatorVersion,
    lexiconHash: manifest.lexiconHash,
    ablation: "A5",
    suites: suiteNames,
  };
  const out = { meta, overall, suites: rows, gates: gates.map(({ actual, pass, ...g }) => ({ ...g, actual, pass })), ablations };
  const stamp = meta.ts.replaceAll(":", "").replaceAll("-", "").slice(0, 15).replace("T", "-");
  const file = join(RESULTS, `eval-${stamp}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n", "utf8");
  writeFileSync(join(RESULTS, "latest.json"), JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\n[eval] wrote ${file} (+ latest.json) in ${meta.elapsedMs}ms`);

  if (args.report) {
    const md = reportMarkdown({ rows, overall, gates, ablations, meta });
    const reportFile = join(RESULTS, "eval-report.md");
    writeFileSync(reportFile, md, "utf8");
    console.log(`[eval] report -> ${reportFile}`);
  }

  if (args.gate) {
    const perf = hard.filter((g) => g.scope === "perf");
    if (advisory.length) {
      console.error(`\n[eval:gate] ADVISORY — ${advisory.length} documented structural/perf gate(s) failed (see report)`);
    }
    if (hard.length) {
      const functional = hard.filter((g) => g.scope !== "perf");
      console.error(`\n[eval:gate] FAIL — ${functional.length} functional, ${perf.length} perf gate(s)`);
      process.exit(1);
    }
    console.log("\n[eval:gate] PASS (functional; advisory items reported above)");
  }
}
main().catch((err) => {
  console.error("[eval] fatal:", err);
  process.exit(1);
});
