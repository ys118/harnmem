# harnmem deterministic eval harness

Offline, deterministic, LLM-free evaluation of harnmem retrieval + consolidation.
The corpus generator is a fixed LCG (seed `20261020`), `now` is frozen at
`2026-10-20T00:00:00Z`, and every metric is a pure function of corpus bytes and
engine config — rerunning the same code yields the same numbers (results files
carry a timestamp, metrics do not).

Source of truth for suite design and gates: `docs/design/05-evaluation.md`.
Research background: `docs/research/memory-evaluation-and-algorithms.md` Part C.

## Quickstart

```powershell
cd <repo>
node evals/gen/generate.mjs          # (re)generate corpora -> evals/corpora/S*/
node evals/run.mjs                   # S1..S12, engine=core if packages/core/dist exists, else js reference
node evals/run.mjs --suite S1,S3,S9  # subset
node evals/run.mjs --gate            # same + gates.json pass/fail, exit 1 on failure
node evals/run.mjs --report          # also write evals/results/eval-report.md
node evals/run.mjs --ablations       # A0..A5 (+A2b synonyms-off) ladder; default suites S1,S2,S3,S5,S7
node evals/run.mjs --ablations --ablation-suites S8_bilingual,S11_noisy_text --queries-cap 10
node evals/run.mjs --queries-cap 10  # stratified query subsample (quick smoke)
node evals/run.mjs --engine js       # force the pure-JS reference store (no @harnmem/core build needed)
node evals/run.mjs --regen --suite S5  # regenerate one suite (delegated to gen/generate.mjs)
```

Build core first for the default engine:

```powershell
pnpm --filter @harnmem/core build
```

## Layout

| path | what |
|---|---|
| `gen/generate.mjs` | deterministic corpus generator (LCG seed `20261020`), writes `corpora/S*/memories.jsonl`, `queries.jsonl`, `labels.jsonl`, `manifest.json`; `--check` re-generates and byte-diffs |
| `data/lexicon.zh.txt` | ~2.5k Chinese domain words (coding / project / profile / data / ops / noise) |
| `data/lexicon.en.txt` | English vocabulary for bilingual suites |
| `data/bilingual.tsv` | zh↔en concept pairs used by S3/S8 |
| `data/synonyms.zh.tsv` | synonym pairs used by distractor / noisy suites |
| `lib/metrics.mjs` | Recall@k, P@1, MRR, nDCG@10, both-recall, abstain FP, forbidden leak, noise@10, cross-lang recall, dedup rate, token cost, latency quantiles |
| `lib/store.mjs` | pluggable store adapter: `js` = `lib/refstore.mjs` pure-JS reference engine; `core` = `@harnmem/core` via `HarnMem.open`/`importRecords`/`search` |
| `lib/refstore.mjs` | harness-local reference retrieval implementation (BM25F + bigram tokenizer + scoring + MMR + link diffusion) used by `--engine js` when core is absent |
| `run.mjs` | runner: loads corpora, builds a fresh temp store per suite under `evals/.tmp/`, runs queries, computes metrics, applies gates, writes results |
| `gates.json` | gate thresholds (mirrors `docs/design/05-evaluation.md` §4) |
| `corpora/S*/` | committed JSONL corpora (deterministic) |
| `results/` | `eval-<stamp>.json` + `latest.json`; optional `eval-report.md` |

Corpora are committed; `--regen` rewrites them from `generate.mjs`. Never hand-edit
`corpora/` — change the generator instead.

## Suites

| suite | competencies | corpus |
|---|---|---|
| S1_profile | stable user profile recall, pinned never dropped | 30 user memories, 25 queries |
| S2_project | project-scoped recall, no cross-project leak | 8 projects / 200 memories, 40 queries |
| S3_temporal | contradiction: new value supersedes old, old value must not win | 120 memories (80 pairs incl. superseded), 40 queries |
| S4_forget | explicit forget: deleted id must not leak | 60 memories, 20 forget queries |
| S5_multihop | two-memory answer reachable only through a link | 300 memories, 30 queries, `both_recall_at_10` |
| S6_abstain | no confident match ⇒ abstain (no false recall) | 1 000 distractors, 40 queries |
| S7_distractor | 5 000 mostly-irrelevant memories, precision@1 | 5 000 memories, 50 queries |
| S8_bilingual | Chinese query vs English memory and vice versa | 500 memories, 40 queries |
| S9_longtail | 10 000 memories: recall, import time, p50/p95 search | 10 000 memories (1 200 unique-token milestones, 50 topical facts, noise filler), 200 queries |
| S10_consolidate | action-level dedupe/merge + supersede semantics + over-merge control | 100 memories (20 groups × 5 kinds), 50 action queries, 100 labels |
| S11_noisy_text | long noisy bodies, recall unaffected | 200 memories (noise wrappers), 30 queries |
| S12_budget | session-start injection budget: pinned kept, tokens ≤ cap | frozen S9 snapshot, 50 repeated session starts |

> S9 scaled down from the original 8792 same-template "long-tail record" filler (each of 50
> topics repeated ~176×, so topical queries were unanswerable by construction) to
> 50 one-off topical facts + noise-domain filler. Unique-token queries stay hard:
> milestone identifiers are the *only* discriminator (`importance`/recency made
> identical across siblings) so the metric measures identifier discrimination, not
> tie-breaking luck.

## S10: action-level consolidation

S10 replay-evaluates `eng.write()` semantics with a hand-labelled corpus. Each of 100
groups (5 kinds) asserts which `WriteAction` the engine must choose, and the 50
queries assert what retrieval must then return:

| group kind | corpus | expected engine action | assertion |
|---|---|---|---|
| (a) exact duplicate | byte-identical title+description+body | `SKIP` | no new memory |
| (b) near duplicate | tokenizer-invisible punctuation/case edits | `MERGE` | merged into canonical, no over-merge |
| (c) supersede | new value contradicts old, banded similarity | `SUPERSEDE` | old status `superseded`, `validTo` set; default search returns new; `include_history`/`as-of` reaches old |
| (d) link-only related | different values, same topic | `LINK` | added, linked, NOT merged |
| (e) novel | new topic | `NEW` | added |

Metrics: `action_accuracy` (group kind vs observed action), `over_merge`
(merge/link actions that should not have happened), `supersede_new_recall`,
`supersede_history` (old value reachable with `include_history`),
`supersede_leak_default` (old value must NOT surface by default). Gates: accuracy
≥0.95, over_merge ≤0.02, new-recall =1.00, history-recall =1.00, default-leak =0.00.

## Metrics (per suite)

`recall_at_1/3/10`, `precision_at_1`, `mrr`, `ndcg_at_10` (binary relevance against
gold ids), `both_recall_at_10` (S5), `abstain_fp` (S6: fraction of negative queries
that returned hits), `forbidden_leak_3/10` (S3/S4), `noise_in_top10` (S7),
`cross_lang_recall` (S8, English queries vs Chinese memories and vice versa),
`action_accuracy`/`over_merge`/`supersede_new_recall`/`supersede_history`/
`supersede_leak_default` (S10), `dedup_rate` (label-level duplicate clustering,
kept for reference), `token_cost_p95`/`pinned_kept` (S12),
`latency_p50/p95/max`, `importMs`, `indexBytes`/`bodyBytes`/`indexOverhead`.

Aggregation: macro-average over measured suites for cross-suite gates, micro-average
over queries for reporting. Empty stores abstain by design; suite gates read from
`results/latest.json`. Latency is measured by the harness around the public engine
call; take one warmup call before quoting p95 (see `docs/design/03-retrieval.md`).

## Gates

`node evals/run.mjs --gate` prints `PASS`/`FAIL` per gate and exits non-zero when
a **functional** gate fails. Gates are split in `gates.json`:

- `suite[]` / `overall[]`: functional gates — these define pass/fail for CI.
- `perf[]`: machine-dependent targets (`build_ms_10k`, `latency_search_p95_ms`,
  `latency_inject_p95_ms`, `token_cost_p95`); printed, reported, but counted
  separately (`--gate` reports `functional: x/y`, `perf: x/y`). Do not treat a perf
  miss as a regression without a clean host and a warm index.

Gates whose suite was not run in the invocation are `n/a` and do not count.
`index_overhead` is computed as `index.sizeBytes / Σ shard body bytes`; for corpora
with very short bodies (S9 synthetic) this ratio is dominated by fixed index cost,
so compare `indexBytes / documentCount` instead when judging size.

## Determinism rules

- `now()` is frozen; no `Date.now()` in corpus generation.
- LCG only (`seed = SEED ^ hash(suite)`), never `Math.random`.
- One fresh temp `home` per suite under `evals/.tmp/` (deleted at start of each run).
- Corpus import uses explicit ids/timestamps via `eng.importRecords(..., { dedupe: false })`
  (or `refstore.importRecords`), so gold ids align with `queries.jsonl`.
- Output order: metrics sorted by suite id; queries in file order.

## Pending

- **Latest verified run** (`results/eval-20261020-105701.json`, frozen core dist
  2026-10-20 18:47:58, sha256 `90234613…`): 12 suites, 565 queries, 24/29
  functional gate rows pass. True functional failures: **S5 `both_recall_at_10`
  0.433 (<0.7)** and **S6 `abstain_fp` 0.100 (>0.05)**; three further failing
  rows are perf/structural by intent (S9 import 10.7 s, S9 warm p95 17.2 ms,
  index 47.18× metric / 2.87× fair) plus cold first query 2.2 s — see
  `results/eval-report.md` §E–G for root causes and follow-up order.
- S10 is now action-level (replays `eng.write()`; 100/100 actions correct after
  the v2 corpus rewrite); `dedup_rate` is kept for reference only.
- A6/A8 (session-start auto-inject selector / optional LLM rerank) are optional
  adapter capabilities — A6 is exercised by S12 (`sessionStart`/`ensureContext`),
  A8 (LLM judge) is out of scope for the deterministic suite.
- S5 link-only multi-hop and S6 abstain calibration remain core-side gaps
  (link diffusion is lexical-seed bound; expansion evidence lifts weak noise
  matches over `abstainLex`). Corpus is frozen meanwhile; changes belong to core.
- Perf numbers mix cold and warm public `HarnMem.search`; the per-shard lazy index
  build (~0.55 s per 2.5k-doc shard) lands in the first query touching each
  shard. Quote warm p50/p95 separately (S9: 14.0/17.9 ms) from cold first query
  (2.2 s); see `results/eval-report.md` §C.
