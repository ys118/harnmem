# harnmem retrieval-level eval report

- generated: 2026-10-20T12:49:44.514Z
- engine: **core** (core) | corpus seed 20261020 | generator gen-1
- suites: 12 | queries: 565 | docs: 27510
- numbers are **retrieval-level** (id-level recall/MRR/nDCG), not end-to-end generation quality.

## Per-suite metrics

| suite | mem | q | R@1 | R@3 | R@10 | P@1 | MRR | nDCG@10 | abstFP | leak10 | p95 ms | action acc | over-merge | sup new | sup hist | sup default leak | pinned kept |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S1_profile | 30 | 25 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | — | — | 6.61 | — | — | — | — | — | — |
| S2_project | 200 | 40 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | — | 0.000 | 20.22 | — | — | — | — | — | — |
| S3_temporal | 120 | 40 | 0.975 | 1.000 | 1.000 | 0.975 | 0.988 | 0.991 | — | 0.000 | 2.90 | — | — | — | — | — | — |
| S4_forget | 60 | 20 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | — | 0.000 | 2.32 | — | — | — | — | — | — |
| S5_multihop | 300 | 30 | 0.500 | 0.850 | 1.000 | 1.000 | 1.000 | 0.935 | — | — | 27.20 | — | — | — | — | — | — |
| S6_abstain | 1000 | 40 | — | — | — | — | — | — | 0.000 | — | 0.73 | — | — | — | — | — | — |
| S7_distractor | 5000 | 50 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | — | — | 398.86 | — | — | — | — | — | — |
| S8_bilingual | 500 | 40 | 0.225 | 0.575 | 1.000 | 0.225 | 0.446 | 0.580 | — | — | 9.75 | — | — | — | — | — | — |
| S9_longtail | 10000 | 200 | 0.995 | 1.000 | 1.000 | 0.995 | 0.997 | 0.998 | — | — | 15.27 | — | — | — | — | — | — |
| S10_consolidate | 100 | 50 | 0.800 | 1.000 | 1.000 | 0.800 | 0.900 | 0.926 | — | — | 10.53 | 1.000 | 0.000 | 1.000 | 1.000 | 0.000 | — |
| S11_noisy_text | 200 | 30 | 0.333 | 0.733 | 1.000 | 0.333 | 0.578 | 0.683 | — | — | 15.00 | — | — | — | — | — | — |
| S12_budget | 10000 | 0 | — | — | — | — | — | — | — | — | 0.01 | — | — | — | — | — | 1.000 |

## S10 write-time action confusion (expected → actual)

| expected \ actual | NEW | SKIP | MERGE | SUPERSEDE | LINK |
|---|---|---|---|---|---|
| NEW | 20 | 0 | 0 | 0 | 0 |
| SKIP | 0 | 20 | 0 | 0 | 0 |
| MERGE | 0 | 0 | 20 | 0 | 0 |
| SUPERSEDE | 0 | 0 | 0 | 20 | 0 |
| LINK | 0 | 0 | 0 | 0 | 20 |

- action accuracy: **1.000** (100 labelled writes, 0 mismatches)
- semantic over-merge: **0.000** (0 NEW/LINK writes wrongly merged/superseded)
- supersede: new-value recall top10 1.000 · old-value history recall 1.000 · old-value default leak 0.000

## Overall

```json
{
  "recall_at_10": 1,
  "mrr": 0.8909,
  "ndcg_at_10": 0.9113,
  "recall_at_3": 0.9158,
  "precision_at_1": 0.8328,
  "macro": {
    "recall_at_10": 1,
    "mrr": 0.8909,
    "ndcg_at_10": 0.9113,
    "recall_at_3": 0.9158,
    "precision_at_1": 0.8328
  },
  "micro": {
    "recall_at_10": 1,
    "mrr": 0.922,
    "ndcg_at_10": 0.9375
  },
  "recall_at_10_s1s2": 1,
  "zh_en_recall_gap": 0,
  "index_overhead": 47.176,
  "build_ms_10k": 12343.6,
  "latency_search_p95_ms": 15.2678,
  "latency_inject_p95_ms": 0.01,
  "token_cost_p95": 207,
  "pinned_kept": 1,
  "suites": "S1_profile:1.000 S2_project:1.000 S3_temporal:1.000 S4_forget:1.000 S5_multihop:1.000 S6_abstain:n/a S7_distractor:1.000 S8_bilingual:1.000 S9_longtail:1.000 S10_consolidate:1.000 S11_noisy_text:1.000 S12_budget:n/a"
}
```

## Gates

| gate | actual | threshold | pass |
|---|---|---|---|
| S1_profile.recall_at_10 | 1.0000 | >= 0.95 | PASS |
| S1_profile.pinned_recall | 1.0000 | >= 1 | PASS |
| S2_project.recall_at_10 | 1.0000 | >= 0.9 | PASS |
| S2_project.scope_leak_10 | 0.0000 | <= 0 | PASS |
| S3_temporal.recall_at_3 | 1.0000 | >= 0.9 | PASS |
| S3_temporal.forbidden_leak_3 | 0.0000 | <= 0.05 | PASS |
| S4_forget.forbidden_leak_10 | 0.0000 | <= 0 | PASS |
| S5_multihop.both_recall_at_10 | 1.0000 | >= 0.7 | PASS |
| S6_abstain.abstain_fp | 0.0000 | <= 0.05 | PASS |
| S7_distractor.precision_at_1 | 1.0000 | >= 0.75 | PASS |
| S7_distractor.noise_in_top10 | 0.0000 | <= 3 | PASS |
| S8_bilingual.cross_lang_recall | 1.0000 | >= 0.7 | PASS |
| S9_longtail.recall_at_10 | 1.0000 | >= 0.85 | PASS |
| S9_longtail.importMs | 12343.6000 | <= 200 | ADVISORY |
| S9_longtail.latency_p95_ms | 15.2678 | <= 5 | ADVISORY |
| S10_consolidate.action_accuracy | 1.0000 | >= 0.95 | PASS |
| S10_consolidate.over_merge | 0.0000 | <= 0.02 | PASS |
| S10_consolidate.supersede_new_recall | 1.0000 | >= 0.9 | PASS |
| S10_consolidate.superseded_history_recall | 1.0000 | >= 0.9 | PASS |
| S10_consolidate.superseded_default_leak | 0.0000 | <= 0.05 | PASS |
| S11_noisy_text.recall_at_10 | 1.0000 | >= 0.7 | PASS |
| S12_budget.token_cost_p95 | 207.0000 | <= 1200 | PASS |
| S12_budget.pinned_kept | 1.0000 | >= 1 | PASS |
| overall.macro.recall_at_10 | 1.0000 | >= 0.88 | PASS |
| overall.recall_at_10_s1s2 | 1.0000 | >= 0.92 | PASS |
| overall.macro.mrr | 0.8909 | >= 0.72 | PASS |
| overall.macro.ndcg_at_10 | 0.9113 | >= 0.65 | PASS |
| overall.zh_en_recall_gap | 0.0000 | <= 0.1 | PASS |
| overall.index_overhead | 47.1760 | <= 0.6 | ADVISORY |
| perf.latency_search_p95_ms | 15.2678 | <= 5 | ADVISORY |
| perf.latency_inject_p95_ms | 0.0100 | <= 50 | PASS |
| perf.token_cost_p95 | 207.0000 | <= 1200 | PASS |
| perf.build_ms_10k | 12343.6000 | <= 200 | ADVISORY |

