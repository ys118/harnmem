/**
 * harnmem eval metrics — definitions frozen by docs/design/05-evaluation.md §4.
 * Pure functions over "query results": { qid, suite, ids[], abstained, latencyMs,
 * tokensEstimate?, gold, forbidden, noise, expectAbstain, lang, kinds }.
 * All retrieval metrics are computed at id level; ties are impossible because the
 * engine returns a strict order. No randomness, no external deps.
 */

export const K_MAX = 10;

/** Recall@k = |gold ∩ topk| / |gold| (0 when gold is empty — those are abstain queries). */
export function recallAt(gold, ids, k) {
  if (!gold.length) return null;
  const top = ids.slice(0, k);
  let hit = 0;
  for (const g of gold) if (top.includes(g)) hit++;
  return hit / gold.length;
}

/** Precision@1 = 1 when the first hit is a gold id. */
export function precisionAt1(gold, ids) {
  if (!gold.length) return null;
  return ids.length > 0 && gold.includes(ids[0]) ? 1 : 0;
}

/** MRR = mean(1 / rank(first gold)); rank is 1-based, truncated at k. */
export function reciprocalRank(gold, ids, k = K_MAX) {
  if (!gold.length) return null;
  for (let i = 0; i < Math.min(ids.length, k); i++) if (gold.includes(ids[i])) return 1 / (i + 1);
  return 0;
}

/** nDCG@10 with binary relevance: DCG = Σ rel_i / log2(i+1), IDCG over min(|gold|,10). */
export function ndcgAt(gold, ids, k = K_MAX) {
  if (!gold.length) return null;
  let dcg = 0;
  for (let i = 0; i < Math.min(ids.length, k); i++) if (gold.includes(ids[i])) dcg += 1 / Math.log2(i + 2);
  let idcg = 0;
  const m = Math.min(gold.length, k);
  for (let i = 0; i < m; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
export function quantile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}
const round = (x, d = 4) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Aggregate one suite's per-query results into the metric row used by gates/report. */
export function computeSuiteMetrics(suite, results) {
  const withGold = results.filter((r) => r.gold.length > 0);
  const abstain = results.filter((r) => r.expectAbstain);
  const withForbidden = results.filter((r) => r.forbidden.length > 0);
  const withNoise = results.filter((r) => r.noise.length > 0);
  const latency = results.map((r) => r.latencyMs);
  const multiHop = results.filter((r) => r.gold.length >= 2);

  const forbiddenLeak = (k) => {
    const leaked = withForbidden.filter((r) => r.ids.slice(0, k).some((id) => r.forbidden.includes(id)));
    return withForbidden.length ? leaked.length / withForbidden.length : null;
  };
  const noiseCount = (k) =>
    withNoise.length
      ? mean(withNoise.map((r) => r.ids.slice(0, k).filter((id) => r.noise.includes(id)).length))
      : null;

  const m = {
    suite,
    nQueries: results.length,
    nGold: withGold.length,
    recall_at_1: round(mean(withGold.map((r) => recallAt(r.gold, r.ids, 1)))),
    recall_at_3: round(mean(withGold.map((r) => recallAt(r.gold, r.ids, 3)))),
    recall_at_10: round(mean(withGold.map((r) => recallAt(r.gold, r.ids, 10)))),
    precision_at_1: round(mean(withGold.filter((r) => r.ids.length).map((r) => precisionAt1(r.gold, r.ids)))),
    mrr: round(mean(withGold.map((r) => reciprocalRank(r.gold, r.ids, 10)))),
    ndcg_at_10: round(mean(withGold.map((r) => ndcgAt(r.gold, r.ids, 10)))),
    both_recall_at_10: multiHop.length
      ? round(mean(multiHop.map((r) => (r.gold.every((g) => r.ids.slice(0, 10).includes(g)) ? 1 : 0))))
      : null,
    abstain_fp: abstain.length ? round(mean(abstain.map((r) => (r.ids.length > 0 || !r.abstained ? 1 : 0)))) : null,
    forbidden_leak_10: round(forbiddenLeak(10)),
    forbidden_leak_3: round(forbiddenLeak(3)),
    noise_in_top10: round(noiseCount(10)),
    forbidden_leak_at: round(forbiddenLeak(10)),
    tunnel_leak: null,
    latency_p50_ms: round(quantile(latency, 0.5)),
    latency_p95_ms: round(quantile(latency, 0.95)),
    latency_max_ms: round(Math.max(0, ...latency)),
    token_cost_p95: round(quantile(results.map((r) => r.tokensEstimate ?? 0), 0.95)),
    zh_en_recall_gap: null,
  };

  // cross-language gap, only meaningful for suites that mix query languages
  const byLang = (lang) => withGold.filter((r) => r.lang === lang);
  const zh = byLang("zh");
  const en = byLang("en");
  if (zh.length >= 5 && en.length >= 5) {
    const rz = mean(zh.map((r) => recallAt(r.gold, r.ids, 10)));
    const re = mean(en.map((r) => recallAt(r.gold, r.ids, 10)));
    m.zh_en_recall_gap = round(Math.abs((rz ?? 0) - (re ?? 0)));
  }
  // project isolation leak: retrieved records of a different project (S2)
  if (results.some((r) => r.foreignHits10 !== undefined)) {
    const sc = results.filter((r) => r.foreignHits10 !== undefined);
    m.scope_leak_10 = round(mean(sc.map((r) => r.foreignHits10)));
  }
  // pinned memories must not be crowded out (S1 gate: pinned hit 100%)
  const pinned = results.filter((r) => r.goldPinned);
  m.pinned_recall = pinned.length ? round(mean(pinned.map((r) => recallAt(r.gold, r.ids, 10)))) : null;
  // S8: en queries target zh memories => recall over en-lang queries = cross-lingual recall
  const enQ = withGold.filter((r) => r.lang === "en");
  m.cross_lang_recall = enQ.length >= 5 ? round(mean(enQ.map((r) => recallAt(r.gold, r.ids, 10)))) : null;
  return m;
}

/** Macro-average across suites (each suite equal) + micro (query-weighted). */
export function aggregate(rows) {
  const withGold = rows.filter((r) => r.nGold > 0);
  const macroRecall = mean(withGold.map((r) => r.recall_at_10).filter((x) => x !== null));
  const microRecall = (() => {
    const totalGold = withGold.reduce((a, r) => a + r.nGold, 0);
    if (!totalGold) return null;
    // weight each suite's recall by its query count
    return withGold.reduce((a, r) => a + r.recall_at_10 * r.nGold, 0) / totalGold;
  })();
  const weighted = (key, filter = () => true) => {
    const rs = rows.filter((r) => r[key] !== null && filter(r));
    const n = rs.reduce((a, r) => a + r.nQueries, 0);
    return n ? round(rs.reduce((a, r) => a + r[key] * r.nQueries, 0) / n) : null;
  };
  return {
    macro: {
      recall_at_10: round(macroRecall),
      mrr: round(mean(withGold.map((r) => r.mrr))),
      ndcg_at_10: round(mean(withGold.map((r) => r.ndcg_at_10))),
      recall_at_3: round(mean(withGold.map((r) => r.recall_at_3))),
      precision_at_1: round(mean(withGold.map((r) => r.precision_at_1).filter((x) => x !== null))),
    },
    micro: {
      recall_at_10: round(microRecall),
      mrr: weighted("mrr", (r) => r.nGold > 0),
      ndcg_at_10: weighted("ndcg_at_10", (r) => r.nGold > 0),
    },
    suites_measured: rows.map((r) => r.suite),
  };
}

export function fmt(x, d = 3) {
  if (x === null || x === undefined) return "n/a";
  return typeof x === "number" ? x.toFixed(d) : String(x);
}
