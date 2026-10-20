# 05 · Evaluation: offline gates, corpora, metrics, and ablations

> Evaluation is a **first-class citizen** in harnmem: any change to ranking, weights, or extraction must pass the gates here before it is merged. The principles come from Part C of the research report: **no LLM, no network, deterministic, scored at the memory-id level** — run `node --test evals/` and you get a score.

## 1. Design principles

1. **Retrieval first**: measure "does the right memory come back, and is the wrong one kept out?" before discussing end-to-end generation quality.
2. **Id-level scoring**: each query carries `gold_ids`, so scoring never depends on generated text or embedding similarity → reproducible and enforceable in CI.
3. **Determinism**: fixed corpus + seed → byte-identical results (float comparison at 1e-9); `now()` is injectable and frozen.
4. **Do not import production-private implementation**: read only `corpora/*.jsonl` plus the public API (`HarnMem.search` / `ensureContext`); a separate set of 30 hand-written golden pairs guards against generator bias.
5. **Report both macro and micro**: macro-average (each suite weighted equally) and micro (weighted by query count), so a large suite cannot drown a small one.

## 2. Corpus format (`evals/corpora/*.jsonl`, diffable)

```jsonc
// memories.jsonl — one record per line
{"id":"m_0001","type":"project","category":"decision","scope":"project","project":"proj_x",
 "title":"...","description":"...","content":"...","tags":["..."],"entities":["..."],
 "importance":8,"pinned":false,"created":1792000000000,"updated":1792400000000,
 "valid_from":1792000000000,"valid_to":null,"links":["m_0002"],"superseded_by":null}
// queries.jsonl
{"qid":"q_01","suite":"S2_project","query":"run the tests before committing?","scope":"project","project":"proj_x",
 "gold_ids":["m_0001"],"forbidden_ids":["m_0100"],"limit":10}
// answers.jsonl (optional; only for e2e / multi-hop)
{"qid":"q_01","gold_ids":["m_0001","m_0002"]}
```

- Corpora are produced by the generator; `manifest.json` records `{seed, lexiconHash, generatorVersion, counts}`.
- A small de-identified real-world set (30 hand-written records) lives in `evals/corpora/real/` and is reported as its own suite, outside the gates (to avoid overfitting).

## 3. Scenario matrix (fixed seed, parameterized scale)

| Suite | Scenario | Size | Queries | Initial gate |
|---|---|---|---|---|
| **S1_profile** | User profile / preferences (stable, heavily pinned) | 30 user records | 25 | Recall@10 ≥ 0.95; pinned hit rate 100% |
| **S2_project** | Project facts / constraints (scoped) | 200 records | 40 | Recall@10 ≥ 0.90; cross-project false recalls = 0 |
| **S3_temporal** | Temporal updates / contradictions (new value supersedes old) | 120 records (40 supersede pairs) | 40 | New value R@3 ≥ 0.90; old value in top3 ≤ 5% |
| **S4_forget** | Explicit forget (including link paths) | 60 records | 20 | Recall of forgotten ids = 0 |
| **S5_multihop** | Multi-hop (two memories combine for one answer) | 300 records (60 linked pairs) | 30 | Two-hop R@10 ≥ 0.70 (both ids in the same injection) |
| **S6_abstain** | Negative samples / abstention (answer not in the store) | 1000 distractor records | 40 | False injection rate ≤ 5% |
| **S7_distractor** | Noisy distractors (1 true + 9 near-duplicates) | 5000 records | 50 | P@1 ≥ 0.75; noise in top10 ≤ 3 |
| **S8_bilingual** | Chinese query ↔ English memory | 500 mixed records | 40 | Cross-lingual R@10 ≥ 0.70 |
| **S9_longtail** | 10k+ pool (long tail / repeated entities) | 10,000 records | 200 | R@10 ≥ 0.85 (hard); import ≤ 200 ms, search p95 ≤ 5 ms (advisory perf targets) |
| **S10_consolidate** | Near-duplicate merge correctness (v2 intended-action corpus) | 400 records (100 groups) | 50 | Intended-action accuracy ≥ 0.95; OverMerge ≤ 2%; complete supersede new/old recall |
| **S11_noisy_text** | Typos / truncation / overlong (>2k chars) | 200 records | 30 | R@10 ≥ 0.70; a 4k-char record must not crash |
| **S12_budget** | Injection budget | S9 pool | 50 | Injected tokens p95 ≤ 1200; pinned entries never squeezed out |

### 3.1 Gate severities (hard vs advisory) and final results (finalized 2026-10-20)

So that CI red means "a real regression", every gate in `evals/gates.json` carries a `severity`: the default is **hard**, while structural/performance gates are marked **advisory**. `node evals/run.mjs --gate` exits 0 when all hard gates are green; a failed advisory gate only prints `ADVISORY` and is recorded in the report (see `gateTable()` and `reportMarkdown()` in `evals/run.mjs`).

| Severity | Gate items | Rationale / handling |
|---|---|---|
| **hard (must be green)** | S1/S2 recall + pinned; S2 scope_leak=0; S3 new-value R@3 + old-value leakage; S4 forget_leak=0; S5 both_recall; S6 abstain_fp; S7 P@1/noise; S8 cross_lang; S9 recall; S10 intended-action accuracy + over_merge + supersede new/old recall; S11 recall; S12 pinned_kept/token; overall macro R@10/MRR/nDCG/zh-en gap; inject p95 | Correctness / isolation / safety / quality gates that must not drift with the machine or corpus convention |
| **advisory (reported, non-blocking)** | S9 importMs, S9 latency_p95; overall index_overhead; perf latency_search_p95, build_ms_10k | One-time migration cost plus v0.2 performance targets; varies widely by stage and machine (local i5-11400F baseline) |

**Final measurements (2026-10-20 19:12, `node evals/run.mjs --engine core --gate --report`, seed=20261020, engine=core, A5 default config)**

| Metric | Value | Gate |
|---|---|---|
| overall macro R@10 | **1.000** | ≥ 0.88 ✅ |
| overall R@10 (S1,S2) | 1.000 | ≥ 0.92 ✅ |
| overall MRR / nDCG@10 / P@1 | **0.891 / 0.911 / 0.833** | ≥ 0.72 / ≥ 0.65 / — ✅ |
| S1 / S2 / S3 / S4 / S5 / S7 / S8 / S9 / S10 / S11 R@10 | all 1.000 (S5 both=1.000; S6 abstain_fp=0.000; S10 action=1.000) | all hard ✅ |
| S8 cross-lingual R@10 / P@1 | 1.000 / 0.225 | R@10 ≥ 0.70 ✅; weak P@1 is ranking quality, recorded as a known limitation |
| S9 import / search p95 / index byte ratio | ~12 s / ~16 ms / 47.18× | ADVISORY (see risk R7 in 06) |
| inject p95 / token p95 / pinned kept | 0.01 ms / 206 tokens / 1.000 | ✅ |
| Wall-clock | 12 suites / 80.8 s | — |

- The full report, per-suite numbers, and ablations live in `evals/results/eval-report.md` (**that file is the source of truth for numbers**); latest.json is the machine-readable version of the table above.
- The S9 10k-scale performance and S12 token budget are measured locally only; CI only needs the functional gates (`--gate` already passes advisory failures through).
- **S10 semantics are implemented**: the corpus labels intended actions `SKIP | MERGE | SUPERSEDE | LINK`; the gates are `action_accuracy ≥ 0.95` (measured 1.000) + `over_merge ≤ 0.02` (measured 0.000) + supersede new/old recall; `dedup_rate` is retained as a diagnostic aid.

## 4. Metric definitions (directly implementable)

```text
Recall@k    = |gold ∩ topk| / |gold|
Precision@1 = fraction of queries whose top1 ∈ gold
MRR         = mean(1/rank(first gold))
nDCG@10     = DCG@10 / IDCG@10 (relevant=1, others=0; graded form optional)
abstain_fp  = fraction of queries that should abstain but received a non-empty injection
forbidden_leak = fraction of queries where a forbidden_id appears in topk
dedup_rate  = correctly merged pairs / labeled near-duplicate pairs (diagnostic; gates use S10 intended_action_accuracy)
over_merge  = wrongly merged pairs / labeled non-duplicate pairs
forget_precision = fraction of forgotten ids that still appear in retrieval/injection (lower is better; gate = 0)
index_overhead = index bytes / total body bytes
latency_{search,inject} = p50/p95/max (ms)
token_cost  = estimated tokens of the injection/tool result (chars/2.8, a conservative Chinese conversion)
```

Aggregate gates (CI failure conditions, deliberately loose at first):

```text
recall@10(overall)   ≥ 0.88
recall@10(S1,S2)     ≥ 0.92
mrr                  ≥ 0.72
ndcg@10              ≥ 0.65
precision@1(S7)      ≥ 0.75
abstain_fp(S6)       ≤ 0.05
forbidden_leak(S3)   ≤ 0.05
intended_action(S10) ≥ 0.95 and over_merge ≤ 0.02
forget_precision(S4) = 1.00
index_overhead       ≤ 0.60        (advisory)
latency_search.p95   ≤ 5ms @10k    (advisory)
latency_inject.p95   ≤ 50ms
token_cost.p95       ≤ 1200
Chinese vs English recall gap ≤ 0.10
```

## 5. Synthetic corpus generator (deterministic, `evals/gen/`)

```text
fixed seed (e.g. 20261020) → LCG: s ← (1103515245·s + 12345) mod 2^31
three entity classes: user profile / project facts / volatile state
each "ground truth" memory gets 1..3 near-synonym distractors + 0..2 superseded history records
Chinese lexicon evals/data/lexicon.zh.txt (~2000 words, domain-tagged); English lexicon likewise
bilingual pairs come from a {zh,en} word map (no translation model call)
emit manifest.json (seed, lexicon hash, generator version) → results are reproducible
```

- Near-synonym distractors use rewrite rules (synonym substitution, word-order changes, added noise); embedding-based generation is **forbidden**.
- S1–S12 each have their own generator; `--scale` can enlarge S9 (10k/50k/100k).
- A separate `evals/golden/queries.jsonl` (30 hand-written pairs) is reported on its own and never used for tuning.

## 6. Ablation matrix (change exactly one item at a time to attribute gains)

| Id | Configuration | Purpose |
|---|---|---|
| A0 | keyword grep (baseline) | Lower bound |
| A1 | +BM25 (single field) | BM25 increment |
| A2 | +CJK bigram + BM25F field weights | Tokenization gain |
| A3 | +field signals (imp/conf/pin/use/recency) | Scoring gain |
| A4 | +two-hop link diffusion | multi-hop gain |
| A5 | +MMR + budget packing | Injection quality/cost |
| A6 | +automatic injection at session start | End-to-end recall |
| A7 | +consolidation (dedupe/supersede) | Size/conflict correctness |
| A8 | +optional LLM selector (off by default) | Upper-bound reference |

The result table lands in `evals/results/eval-report.md` (one table plus one figure); CI keeps each run's `evals/results/<timestamp>.json`.

## 7. Public benchmarks: how to speak honestly

- **Runnable and claimable**: the **retrieval stage** of LoCoMo and LongMemEval (given a query and gold memory labels) — we report only Recall@k/nDCG, never generation scores.
- **Not claimed**: end-to-end LLM-judge scores (a full LongMemEval run is ≈170M tokens/run — expensive and dependent on the judge prompt); if needed, run a small sample in a real harness per §8 and label it "pilot, n=200, ±0.07".
- Any number quoted from other systems (Mem0, MemOS, MemBench) must be marked as a **secondary source** and must never be mixed into our own results table.
- External README wording: `retrieval-level evaluation`; never "beats X on Y".

## 8. Optional end-to-end evaluation (harness-only, not in CI)

1. Question generation: sample 200 records from the 10k pool and let the harness model generate "how a user would ask"; keep the 3 candidates with the lowest token overlap against the source.
2. Run: inject top-8 → model answers → record `{qid, injected_ids, answer, tokens, latency}`.
3. Scoring: 2-point rubric, judge = a different model family, temperature=0, 3 independent runs.
4. Statistics: mean ± t·s/√3 (n=3, t=4.303); report run-to-run agreement and κ.
5. Cost: 200 questions ≈0.4M tokens/round; 3 rounds + 3 judge passes ≈1.5M tokens per evaluation, run manually only.

## 9. CI wiring

```bash
pnpm test          # unit tests: tokenizer/BM25/dedupe/lifecycle (node:test, no network)
pnpm eval          # run S1–S12 (default 10k scale, ~10-20s)
pnpm eval:gate     # enforce gates (CI; non-zero exit on failure)
pnpm eval:report   # emit evals/results/eval-report.md (tables + key ablations)
```

- Gate numbers are centralized in `evals/gates.json`; any gate change must be justified in its PR.
- Performance gates use the local i5-11400F baseline with a ±3× tolerance to avoid CI-machine false alarms (alternatively: CI runs functional gates only and performance runs locally).
