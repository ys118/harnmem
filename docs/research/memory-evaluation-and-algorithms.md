# Memory research: public benchmarks/metrics, retrieval & consolidation algorithms, and the harnmem offline evaluation plan

> Project: **harnmem** (cross-harness memory for pi / DSH / Claude Code; zero external services; plain-file SSOT; zero-dependency TypeScript)
> Date: 2026-10-20 · Status: design input (companion to `docs/design/01-architecture.md` and `02-data-model.md`)
> Environment probes and the 10k benchmark were measured on the development host (Node v24.9.0 / Windows 11).

## 0. TL;DR (conclusions first)

1. **On this host, `node:sqlite` is available and `ENABLE_FTS5=1`** (SQLite 3.50.4, no flag needed, only an ExperimentalWarning). However, **the default FTS5 tokenizer indexes each contiguous run of Han characters as a single token** (so a query for a two-character word inside a longer phrase finds nothing); the `trigram` tokenizer requires queries of at least 3 characters, so most two-character Chinese words miss as well → **Chinese retrieval must do its own CJK bigram tokenization before feeding any backend**.
2. **Measured on 10k synthetic memories: a pure-JS BM25 (in-memory inverted index) builds in 45 ms and queries at p50 0.11 ms / p95 0.28 ms; FTS5 (after bigram pre-tokenization) builds in 61 ms and queries at p95 1.17 ms; both return exactly the same top-3** → default to pure JS; SQLite/FTS5 is only an optional on-disk index accelerator, never the main path.
3. Public benchmarks (LoCoMo/LongMemEval/MemoryAgentBench/MemBench) **all rely on LLM judging and long contexts**, so they cannot be copied directly; we perform a **"retrieval-stage translation"**: label query→gold memory id and compute Recall@k / MRR / nDCG@10 offline, with zero LLM, zero network, and full determinism.
4. We have no embeddings → retrieval uses **CJK bigrams + BM25 + the memory's own field signals** (importance/confidence/pinned/used_count/recency/links) combined into a score; the LLM is only an **optional** adapter for importance rating, query expansion (HyDE), or reranking.
5. Conflict resolution uses **bi-temporal supersede** (`superseded_by` + retained history + `updated`); nothing is ever hard-deleted. Forget moves records to `trash/` (restorable); expiry only archives.
6. Deduplication: **SimHash 64-bit (Hamming ≤ 3) coarse filter → Jaccard(character bigram shingles) ≥ 0.82 with identical type/scope before merging**; merges keep the provenance chain and `supersedes`.
7. **Honest framing**: we may claim "retrieval-stage metrics plus semantic ground truth on an offline synthetic set"; we may not claim "beats mem0 on LoCoMo". Running LoCoMo/LongMemEval **retrieval-only** (using their evidence labels to compute R@k/nDCG) is feasible and cheap.
8. Minimum runtime: the core library **depends on no Node built-ins** (ES2022, works on Node ≥18 / Bun / Electron); the FTS5 adapter needs **Node ≥ 22.13** (no flag) or **Electron ≥ 36.7.3**, while **Claude Code's Bun can only use `bun:sqlite` (`node:sqlite` is unimplemented in Bun)**. pi requires Node ≥22.19 → satisfied.

---

## Part A · Benchmarks and metrics

### A.1 Overview table

| Benchmark | Source | Task categories | Data construction | Main metrics | Verified headline numbers |
|---|---|---|---|---|---|
| **LoCoMo** | Maharana et al., 2024, [arXiv:2402.17753](https://arxiv.org/abs/2402.17753) | QA (single-hop / multi-hop / temporal / open-domain), event summarization, multimodal dialogue generation | Machine-human pipeline: persona + temporal event graph generation with human verification; **average 300 turns / 9K tokens, up to 35 sessions**; includes image sharing/reactions | QA: **token-F1, BLEU-1** (ROUGE for summarization; GPT-4V judging for multimodal) | Abstract-level: long-context models and RAG improve but remain **substantially behind humans**; follow-up systems (mem0/MemOS) mostly re-measure with F1/BLEU-1/J |
| **LongMemEval** | Wu et al., **ICLR 2025**, [arXiv:2410.10813](https://arxiv.org/abs/2410.10813) · [ICLR page](https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html) | Five abilities: **information extraction (IE), multi-session reasoning (MR), temporal reasoning (TR), knowledge update (KU), abstention (ABS)** | **500 hand-curated questions** embedded in freely extensible user-assistant histories (the community commonly works at ~115K tokens) | Main metric **QA accuracy (LLM judge, GPT-4o)**; retrieval stage **Recall@k / nDCG@k**, latency, context tokens | Commercial assistants and long-context LLMs **lose ~30% accuracy** under sustained interaction; proposes the index/retrieval/reading framework and three optimizations (session decomposition, fact-augmented key expansion, time-aware query expansion) |
| **MemoryAgentBench** | Hu, Wang et al., 2025, [arXiv:2507.05257](https://arxiv.org/abs/2507.05257) | Four competencies: **accurate retrieval, test-time learning, long-range understanding, selective forgetting** (the v4 abstract replaces earlier "conflict resolution" with selective forgetting) | Converts existing long-context datasets into **incremental multi-turn format** plus new datasets; requires "accumulate while interacting" | Per-competency accuracy (unit-test/QA based), plus context length and throughput | Abstract-level finding: **no existing method masters all four competencies** (no single quotable number) |
| **MemBench** | Tan et al., **ACL 2025 Findings**, [ACL page](https://aclanthology.org/2025.findings-acl.989/) · code [Membench](https://github.com/import-myself/Membench) | Memory levels: **factual / reflective**; interaction modes: **participation / observation** | Custom dataset (secondary sources report ~53k samples and 100K-token scenarios) | **effectiveness / efficiency / capacity**; accuracy for factual questions, text similarity (ROUGE-L-like) or LLM judging for reflective ones (see the paper's tables for the exact protocol) | Secondary source: in the 100K-token scenario **RetrievalMemory scores 0.833 factual accuracy**, beating more elaborate mechanisms (e.g. GenerativeAgent 0.455) → "simple retrieval is the most stable at large memory-pool scale" |
| **MemOS** (system, not a benchmark) | Li et al., 2025, [arXiv:2507.03724](https://arxiv.org/abs/2507.03724) | MemCube (parametric/activation/plaintext memory), scheduling, lifecycle | Run on LoCoMo, LongMemEval, etc. | LLM-judge **Overall**, context tokens, throughput | Secondary source: LoCoMo Overall **75.80** (same GPT-4o-mini backbone, vs Mem0 64.57 / Zep 59.22 / Memobase 72.01), context ~**1.6K tokens** |
| Surveys | [arXiv:2512.13564](https://arxiv.org/abs/2512.13564) "Memory in the Age of AI Agents"; [arXiv:2504.15965](https://arxiv.org/abs/2504.15965) "From Human Memory to AI Memory" | Memory forms (parametric/contextual/plaintext), functions, dynamics (formation/evolution/retrieval) | — | — | The surveys list **LoCoMo / LongMemEval / MemoryAgentBench** as the three "standard" memory benchmarks and note that evaluation still lacks **write cost / latency / privacy** dimensions |

> Labeling rule: "verified" above means I actually read the paper abstract/homepage text; "secondary source" means a GitHub/notes-style second-hand analysis — **must be attributed as second-hand when cited**, and never treated as a paper number.

### A.2 LoCoMo's key design (and what it implies for us)
- Observations are **turn/session units with a timestamped event graph** → temporal-reasoning questions become constructible. This is exactly what our `created/updated/last_used` + `supersedes` must align with.
- Evaluation has three stages (QA / summarization / multimodal) → our synthetic suite should also be **staged**: score the retrieval stage only; never mix "retrieval quality" and "generation quality" into one number.
- Metrics are **token-F1 / BLEU-1**: friendly to short factual answers, but poorly discriminative for **long Chinese answers** → we use F1 only as an optional proxy and rely on id-level retrieval metrics instead.

### A.3 LongMemEval's key design (closest to us)
- Its five abilities map directly onto our synthetic scenarios: IE→profile extraction, MR→multi-hop, TR→temporal, KU→supersede, ABS→abstention.
- All three paper optimizations are **pure retrieval-side and model-free**, so they can be adopted directly:
  1. **session decomposition** (split long sessions into value-granular keys) → one memory = one value naturally satisfies this;
  2. **fact-augmented key expansion** (add facts/keywords to each key at index time) → we index `title + description + tags` together;
  3. **time-aware query expansion** (widen the retrieval range by time words) → a Chinese time-word table ("last week/yesterday/recently/now") → time-window filtering.
- Reporting format: **accuracy (judge) + Recall@k + latency + context tokens** as a quartet → our report template follows the same structure.

### A.4 What MemoryAgentBench teaches us
- "**Incremental / multi-turn**" is the real shape of a memory system → our offline suite must simulate **sequential writes followed by mid-stream queries**, not fill the store once and query.
- Among the four competencies, **selective forgetting** maps one-to-one onto the decay/archive strategy in Part B, so we need a "forgot what should be forgotten" metric (see C.4 forgetting precision).

### A.5 What MemBench teaches us
- It separates **factual vs reflective** ("the user likes concise answers" vs "the user is impatient, so keep it short") → our `type` field must distinguish `fact` from `insight`; reflective-memory recall can only be judged by an LLM, so it stays in the optional stage.
- It separates **participation vs observation** ("I took part in" vs "I witnessed") → maps onto the trust level of our `source.harness/session/turn` and whether the user said it themselves.
- At large memory-pool scale, **simple retrieval beats elaborate mechanisms** → do not introduce graph structures prematurely; first make BM25 + field signals solid.

### A.6 Metric definitions (directly implementable)

```text
# Retrieval stage
Recall@k        = |Rel ∩ TopK| / |Rel|
Precision@k     = |Rel ∩ TopK| / k
MRR             = (1/|Q|) * Σ_q  1 / rank_q(first relevant)
DCG@k           = Σ_{i=1..k} rel_i / log2(i+1)          # binary rel
nDCG@k          = DCG@k / IDCG@k
Hit@k           = 1[ |Rel ∩ TopK| > 0 ]
# Generation stage
token-F1        = 2PR/(P+R)      # SQuAD-style, over answer token sets
EM              = 1[ normalize(pred) == normalize(gold) ]
BLEU-1          = weighted unigram precision (with brevity penalty)
ROUGE-L         = F of LCS-based recall/precision
J-score         = (1/|Q|) * Σ_q judge(q, pred_q, gold_q)   # 0..100 or 0/1/2
# Cost/performance
TokenCost       = mean(injected + retrieved context tokens), p95
Latency         = p50 / p95 of search() and buildInjection()
DedupRate       = |near-duplicate pairs merged| / |labeled near-duplicate pairs|
OverMergeRate   = |semantically different pairs wrongly merged| / |merged pairs|
ForgetPrecision = 1 - |decayed/archived but should have been kept| / |total decayed or archived|
IndexOverhead   = indexBytes / corpusBytes
```

**Judge rubric (we copy the LongMemEval style; a 2-point scale is the most stable)**:

```text
System: You are an exacting evaluator. Judge only whether the ANSWER is
supported by GOLD and by the RETRIEVED CONTEXT. Ignore style, length, language.
Return JSON {"score": 0|1|2, "reason": "<=15 words"}
2 = fully correct & consistent with GOLD (all parts, incl. numbers/dates)
1 = partially correct / missing one required element / over-generalized
0 = wrong, contradicts GOLD, or answer not derivable from context
Do NOT reward extra detail. Do NOT penalize brevity.
```

### A.7 Published baseline numbers (the only permissible way to cite them)

| System | Benchmark | Numbers | Source nature |
|---|---|---|---|
| **mem0** | LoCoMo | **+26% relative improvement (LLM-as-a-Judge) vs OpenAI memory**; graph variant a further **+~2% overall**; **p95 latency −91%**, **token cost −90%+** (vs full-context) | Paper abstract (verified) [arXiv:2504.19413](https://arxiv.org/abs/2504.19413) |
| **Zep/Graphiti** | DMR / LongMemEval | **DMR 94.8% vs MemGPT 93.4%**; LongMemEval **up to +18.5% accuracy**, **latency −90%** | Paper abstract (verified) [arXiv:2501.13956](https://arxiv.org/abs/2501.13956) |
| **A-MEM** | 6 base models | "superior improvement vs existing SOTA" (abstract gives no single number) | Paper abstract (verified) [arXiv:2502.12110](https://arxiv.org/abs/2502.12110) (NeurIPS 2025) |
| **MemOS** | LoCoMo | Overall 75.80, context ~1.6K tokens | **Secondary source**; defer to the paper's tables |
| **MemBench** | custom 100K | RetrievalMemory 0.833 vs GenerativeAgent 0.455 | **Secondary source** (notes); defer to the ACL paper's tables |
| **Full-context / MemGPT / Letta** | LoCoMo / DMR | The baseline numbers in the mem0 and Zep papers cannot be transplanted (different judge/prompt/subset) | Cite paper by paper; cross-paper table splicing is forbidden |

> **Important warning**: these numbers **must not be used for marketing comparisons**. They are only comparable under the same LoCoMo subset, the same judge model, and the same answer-extraction prompt; the community has repeatedly reproduced differences of ±5–10 points. Our report cites only "structural conclusions" (e.g. "simple retrieval is more stable at large pool sizes"), never absolute values.

### A.8 LLM-as-judge pitfalls and mitigations
| Pitfall | Symptom | Mitigation (that we can implement) |
|---|---|---|
| Position bias | Swapping A/B order flips the verdict | Run **both directions** per evaluation and take the agreement; or score a single answer against gold absolutely (recommended, avoids pairwise comparison) |
| Verbosity bias | Longer answers score higher | The rubric explicitly says "Do NOT reward extra detail"; record length as a covariate |
| Non-determinism | Same input, different scores | **temperature=0**; fixed seed (if the provider supports it); **run 3 times and report mean ± 95% CI** |
| Self-preference | The judge favors models from its own family | Use a judge from a **different family** than the generator, or average two judges |
| Score drift | A new prompt version shifts all scores | **Version the judge prompt** + compute **Cohen's κ** against a 20-item human-labeled regression set; reject a judge version with κ<0.6 |
| Parse failure | Output is not JSON | Enforce a JSON schema + retry once + count failures in a `parse_error` rate (>2% invalidates that round) |

---

## Part B · Algorithms (implementable in zero-dependency TypeScript)

### B.1 Generative Agents retrieval: three-component weighting
Paper [arXiv:2304.03442](https://arxiv.org/abs/2304.03442) / [ACM DOI](https://dl.acm.org/doi/10.1145/3586183.3606763):

```text
recency(o)    = decay ^ Δhours(o)          # decay = 0.995; Δhours = now - last retrieved time
importance(o) = normalized to [0,1] after an LLM 1..10 rating   # "poignancy"
relevance(o)  = cos(emb(q), emb(o))         # they use embeddings; we do not have any
score(o)      = α_rec·recency + α_imp·importance + α_rel·relevance
# In the paper's main experiments all α are 1, after min-max normalizing each component to [0,1]
```

**Embedding-free substitutes (pick one; 1+2 recommended)**
```text
1) relevance := BM25(q, o) min-max normalized to [0,1] (our default)
2) relevance := 0.7·cos_bigram(q,o) + 0.3·BM25(q,o)
   cos_bigram: cosine over TF-IDF vectors of CJK character bigrams / Latin words (pure JS, no model)
3) relevance := 0.5·cos_bigram + 0.5·tagOverlap(q.tags, o.tags) + linkBonus
When switching decay from "hours" to "days": 0.995^24 ≈ 0.8866/day; we keep decay in config (default 0.995/hour)
Proxy for importance when no LLM is available: importance = 4 + 3·log1p(used_count) + 2·pinned + 1·(type∈{decision,constraint,preference})
```

### B.2 MemoryBank: the Ebbinghaus forgetting curve ([arXiv:2305.10250](https://arxiv.org/abs/2305.10250) · [AAAI PDF](https://ojs.aaai.org/index.php/AAAI/article/download/29946/31654))

```text
R(t) = exp(-t / S)            # R: retention; t: time since last review; S: memory strength
# Each successful recall increases S (review reinforcement):
S ← S · (1 + β·recall_signal)         # β empirically 0.1~0.3; recall_signal ∈ [0,1]
# Forgetting: R(t) < θ (θ≈0.2~0.3) → no longer "injectable" (we use three tiers instead: downweight → archive → trash)
```
harnmem implementation: `S₀ = f(importance, confidence)`, e.g. `S₀ = 3 + 7·(importance/10) days`; `used_count++`/`last_used` updates reinforce per the formula above; `R < 0.3` → `status=archived` (still searchable, weight ×0.4); `R < 0.05` and `pinned=false` and unused for 90 days → `trash/` (restorable). **Never a hard delete.**

### B.3 mem0: extraction + ADD/UPDATE/DELETE/NOOP ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413))

```text
# Write path (two LLM stages)
1 extraction: from the last few turns → candidate fact list C = [{text, type, tags, importance}]
2 for c in C:
     S = topk_similar(c, k=8)             # they use embeddings; we use BM25 + field signals
     op = LLM(decide, c, S) ∈ {ADD, UPDATE(m), DELETE(m), NOOP}
   # Semantics: ADD=new memory; UPDATE=synonymous with an existing one but more precise → overwrite body + append provenance;
   #            DELETE=contradicts an existing one and is newer → we change this to SUPERSEDE (retain history, see B.9);
   #            NOOP=already present, just refresh used_count/last_used
# Read path: query → vector search top-k → splice directly into context (no rerank)
```
Our difference: **replace DELETE with SUPERSEDE** (`superseded_by` points at the new memory, the old one gets `status=superseded`, never deleted), because a plain-file SSOT must be auditable and rollback-able.

### B.4 A-MEM: Zettelkasten notes + links + evolution ([arXiv:2502.12110](https://arxiv.org/abs/2502.12110))

```text
note = {content, keywords[], tags[], context, links[]}
on insert(note):
  cands = topk_similar(note, k=5)            # the paper uses embeddings
  for c in cands where sim > τ_link:         # τ_link≈0.6 (with no embeddings, use BM25 + tag Jaccard)
      note.links += c.id ; c.links += note.id   # bidirectional links
  # memory evolution: a new note may "write back" into older notes' context/tags (closer to human reconstruction)
  for c in cands:
      c.context = LLM(update_context, c, note)   # optional, audited
```
Implementation recommendation: **create links automatically, and make evolution append-only (never rewrite the body)**, otherwise the auditability of "immutable memory + provenance" breaks. Evolution is recorded in `links` and `provenance`; the body changes only on an explicit UPDATE.

### B.5 Letta / MemGPT: core vs archival + recursive summarization ([arXiv:2310.08560](https://arxiv.org/abs/2310.08560))

```text
main_context = system_prompt + core_memory(blocks: persona, human, project) + recent_turns
external     = recall_storage(full history) + archival_storage(vector store, retrieved on demand)
# Triggered at a context-pressure threshold (~70% of the window):
1 summarize the oldest turns into a summary in recall_storage, keeping the originals in external storage
2 recursive summarization: summary_new = LLM(summary_old ⊕ evicted_turns)
3 core_memory is explicitly edited by the LLM (replace/insert/rethink), each edit audited
```
What we copy: **core memory = the injected pinned/high-importance memories (≤N)**; **archival = every other memory, retrieved on demand**; **recursive summarization = compress the "previous session summary" into one paragraph at session start**. What we do not do: "LLM freely edits core memory" (off by default; requires explicit `--allow-core-edit`).

### B.6 Zep / Graphiti: bi-temporal knowledge graph ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956))

```text
episode(raw dialogue fragment) → extract entities/relations → edge e=(src, rel, dst, fact, t_valid, t_invalid)
Bi-temporal: t_valid/t_invalid = when the fact holds/ceases to hold in the real world (event time)
             created_at/expired_at = when the system ingested/invalidated it (ingestion time)
On contradiction: e_old.t_invalid = e_new.t_valid  (**invalidate, never delete**)
Retrieval: query → entity lookup → subgraph → serialize edge sequence as text → rerank
Community summaries: partition the entity graph into communities and periodically generate community summaries ("higher-level memory" of the graph)
```
We do not need a graph database, but the **bi-temporal fields must be in the schema** (`valid_from`, `valid_to`, `superseded_by`); retrieval prefers `valid_to == null`, and historical queries can pass an explicit `--as-of`.

### B.7 HippoRAG: Personalized PageRank ([arXiv:2405.14831](https://arxiv.org/abs/2405.14831))
```text
# Offline: KG (entities/relations) + passage nodes; online: query entities as seeds
ppr = PersonalizedPageRank(G, seeds=query_entities, damping=0.5, iters=20)
rank(passages) = Σ_{entity∈passage} ppr[entity]
```
We only implement a lightweight **two-hop diffusion** over the "memory graph" (`links` edges):
```text
seed = top-3 BM25 hits
for m in seed: for n in m.links: bonus[n] += 0.5^hop * sim(m, q)
final = 0.8·BM25(m,q) + 0.2·bonus[m]     # weights go into config
```

### B.8 Hybrid lexical retrieval (the part we actually have to write)

**BM25 (Okapi)**:
```text
idf(t)      = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
score(q,d)  = Σ_{t∈q} idf(t) · (tf·(k1+1)) / (tf + k1·(1 - b + b·|d|/avgdl))
# defaults k1=1.2, b=0.75 (the values we measured with)
```
**Variants**
```text
BM25+   : score += δ,   δ≈1.0 (relieves the low-tf penalty on long documents/queries; small gain for "short memories")
BM25F   : weighted field tf merge: tf*(t,d) = Σ_f w_f·tf(t,d_f)/(1-b_f+b_f·|d_f|/avgdl_f)
          suggested field weights w: title 3.0, tags 2.5, description 2.0, body 1.0
```
**Chinese tokenization (zero dependencies)** — the most effective approach measured was "character bigrams + Latin words":
```ts
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const re = /[\u4e00-\u9fff]+|[A-Za-z0-9_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[0];
    if (/[\u4e00-\u9fff]/.test(t)) {
      if (t.length === 1) { out.push(t); continue; }
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2)); // "用户偏好" -> 用户, 户偏, 偏好 (CJK bigrams)
      out.push(t[0], t[t.length - 1]);                                   // boundary unigrams, cover 1-char queries
    } else out.push(t.toLowerCase());
  }
  return out;
}
// Measured: 10k docs, avg 14.4 tokens/doc, build 45ms, search p95 0.28ms
```
**RRF (fusing multiple rankings; Cormack et al., SIGIR 2009)**
```text
RRF(d) = Σ_{r∈ranks} w_r / (k + rank_r(d)),  k = 60 (standard), rank starts at 1
# Fuses the "BM25 ranking", "field-signal ranking", "graph-diffusion ranking", and optional "dense ranking" without score calibration
```
**Query expansion**
```text
# Zero-cost (on by default): synonym expansion using the memory store's own tags/links
q' = q ∪ {tag | tag has high bigram overlap with q's tokens} ∪ {tags of the top-1 hit}
# Optional (LLM adapter, off by default): HyDE — have the LLM "hypothesize an answer" first, then retrieve
hyde: q'' = q ∪ tokens(LLM("Write a one-sentence memory that would answer: " + q))
# Optional (LLM adapter): time-aware expansion (LongMemEval idea)
"last week" → created ∈ [t-14d, t-7d]; "now/latest" → filter status=active and sort by updated desc
```
**Rerank adapter**: interface `rerank(query, candidates, topk) => Scored[]`, default `null` (no-op); optional implementations = LLM listwise (score 10 items, return a JSON array) or a future dense provider. **Never bundle a model.**

### B.9 Deduplication / consolidation / value scoring / decay-archive

**SimHash (Charikar 2002; Manku et al. WWW 2007)** — O(1) near-duplicate coarse filter:
```text
1 64-bit features: hash64(token) over tokenize(text) (FNV-1a, two rounds combined into 64 bits)
2 vote per bit with token weight w=tf·idf; bit i: sum_w(+1 if bit_i(h)=1 else -1) → sign>0 ? 1 : 0
3 Near-duplicate test: popcount(simhash(a) XOR simhash(b)) ≤ 3
```
**MinHash + LSH (Broder 1997; Indyk-Motwani 1998)** — for larger scale:
```text
shingles = character 3-gram set (Chinese) / word 3-gram (English)
sig_k(d) = min_{h∈H_k}(h(shingle))      # k=128 permutations
Ĵ(a,b)  = |{i: sig_a[i]==sig_b[i]}| / k
LSH: b bands × r rows, b·r=k; identical within a band → candidate
threshold ≈ (1/b)^(1/r); for τ=0.8 use b=32,r=4 ((1/32)^{1/4}≈0.42 → too loose; use b=16,r=8 → 0.71)
```
**Merge policy (thresholds empirical; tune in the suite)**
```text
near-duplicate: same type and same scope and Jaccard(shingle) ≥ 0.82 and no substantive numeric/date conflict → MERGE
        (keep one body; merge provenance; sum used_count; updated=max; importance=max)
suspected synonym: 0.60 ≤ Jaccard < 0.82 → do not rewrite, just add a link (for two-hop recall)
conflict: same subject+attribute but different values → SUPERSEDE (new memory valid_from=now;
        old memory valid_to=now, superseded_by=new.id, status=superseded)
        — numeric/date/version/path conflicts must take this path and must not be merged as near-duplicates
```
**Memory value scoring (accounted at write time, consumed at read time)**
```text
value(m) = 0.35·(importance/10) + 0.20·confidence + 0.15·min(1, log1p(used_count)/log1p(20))
         + 0.15·pin + 0.10·sourceTrust + 0.05·recency_norm
sourceTrust: user said it = 1.0; tool/command output = 0.8; model inference = 0.5; second-hand summary = 0.4
pin ∈ {0,1}, set by an explicit user `pin` or automatically when `type∈{constraint,security}`
```
**Decay / archive / delete (three tiers + grace period + audit)**
```text
active → archived:  R(t) < 0.30 and not pinned and not type∈{constraint,decision}
archived → trash:   R(t) < 0.05 and unused for 90d and not pinned
trash → (hard delete): only after a 30d grace period inside trash, and only with explicit user `--purge` (never by default)
Every transition: append to state/audit.jsonl {mem_id, from, to, reason, ts, rule_version}
restore: fetch back from trash/ or archive/, reset R=1 and S=S₀ (audited)
```

### B.10 **Recommended scoring formula for harnmem (lexical-only default)**

```text
# --- Hard filters (not part of ranking) ---
status == active            (with --as-of, filter by valid_from/valid_to)
scope ∈ {user, current_project}; project match (on conflict, user scope only)
type whitelist (at injection time, optionally exclude low-confidence insight)

# --- Signal components (all normalized to [0,1]) ---
lex  = minmax( BM25F(q, m) )                      # B.8, field weights title3/tags2.5/desc2/body1
imp  = importance / 10
conf = confidence                                  # 0..1
rec  = 0.995 ^ hours_since( max(last_used, updated) )
use  = min(1, log1p(used_count) / log1p(20))
pin  = pinned ? 1 : 0
link = min(1, 0.5·hop1 + 0.25·hop2)                # two-hop diffusion from the top-3 seeds along links (B.7)
stale= (now - updated > TTL(type)) ? 1 : 0        # TTL: preference 365d, fact 180d, state 30d

# --- Linear combination (default weights, configurable) ---
S(q,m) = 1.00·lex + 0.15·imp + 0.10·conf + 0.12·rec
       + 0.08·use + 0.25·pin  + 0.20·link - 0.30·stale

# --- MMR de-duplication (at injection time) ---
MMR_i = λ·S_i - (1-λ)·max_{j<i} cos_bigram(m_i, m_j),  λ = 0.7
# --- Budget packing ---
greedy: descending MMR, cumulative tokens ≤ budget (default 8 items / 1200 tokens),
        at most 3 items per type; pinned hits are mandatory (and count against the budget)
# --- Abstention threshold ---
if top1's lex < τ_abs (τ_abs≈0.15) and link==0 and pin==0 → return an empty injection (abstain)
```

**Trade-offs (must be written into the design doc)**
| Choice | Benefit | Cost |
|---|---|---|
| lex weight 1.0 dominating | Explainable, offline-tunable, no model | Weak on synonyms/paraphrases (compensated by tag expansion) |
| pin 0.25 + hard guarantee | User-explicit memories are never squeezed out | Permanently consumes budget → budget packing must cap pinned entries |
| rec 0.12, decay 0.995/h | New memories rank first | Frequently reused old memories depend on `use` for compensation, otherwise they get neglected |
| stale penalty 0.30 | Expired facts do not mislead | Requires typed TTLs, otherwise long-lived constraints are penalized |
| MMR λ=0.7 | Injection diversity, budget savings | Can squeeze out second-hop memories that are relevant but not literally similar → compensate with `link` |
| Do not merge the 0.60–0.82 band | No information loss | The store grows → control size through archiving |

**Expected results (acceptance targets, not promises)**: single-hop Chinese Recall@10 ≥ 0.90; synonyms/paraphrases ≥ 0.75; multi-hop (two hops) ≥ 0.70; Precision@1 ≥ 0.7 under 10k-pool distractors; query p95 < 5 ms (in-memory index).

---

## Part C · The harnmem offline evaluation plan (the most important deliverable)

### C.1 Design principles
1. **Zero LLM, zero network, deterministic**: running `node --test` yields the score; the same corpus + seed → byte-identical results (floats compared at 1e-9).
2. **Retrieval stage first**: nail down "record what should be recorded, find what should be found" before discussing generation quality.
3. **Metrics on ids**: queries carry gold memory ids and never depend on generated text → reproducible and enforceable in CI.
4. **Chinese/English reported separately**: the same scenario in two languages; never report only the overall average.
5. **Regressable**: results land in `evals/out/<git-sha>.json`, compared against the previous run with `Δ`; exceeding a threshold raises an alert.

### C.2 Data format (`evals/corpora/*.jsonl`, JSONL only, diffable)

```jsonc
// memories.jsonl — the final state of the simulated SSOT (not a temporary load at query time)
{"id":"mem_a1","type":"preference","scope":"user","title":"answering style","description":"The user prefers concise Chinese answers without pleasantries","tags":["style","chinese"],"importance":8,"confidence":0.95,"pinned":true,"status":"active","created":1792337217231,"updated":1792337217231,"last_used":1792487631672,"used_count":7,"source":{"harness":"dsh","session":"s1","turn":3,"ts":1792337217231},"links":[],"supersedes":[],"superseded_by":null,"valid_from":1792337217231,"valid_to":null}
{"id":"mem_b2","type":"project_fact","scope":"project","project":"harnmem","title":"index location","description":"Derived index lives in ~/.harnmem/index and can be deleted and rebuilt at any time","importance":6,"confidence":0.9,"pinned":false,"status":"active", ...}
{"id":"mem_b2_old","type":"project_fact","scope":"project","project":"harnmem","title":"index location","description":"Old plan: put the index under .harnmem/ in the repo","status":"superseded","superseded_by":"mem_b2","valid_from":1790000000000,"valid_to":1792400000000}

// queries.jsonl — evaluation questions (gold is a list of memory ids, not text)
{"qid":"q_001","kind":"single-hop","lang":"zh","query":"What answering style does the user like?","expected":["mem_a1"],"k":10,"suite":"S1_profile","notes":"stable preference"}
{"qid":"q_002","kind":"multi-hop","lang":"zh","query":"Where is the index and can I delete it?","expected":["mem_b2"],"k":10,"suite":"S5_multihop","must_have_all":true}
{"qid":"q_003","kind":"temporal","lang":"zh","query":"Where does the index live now?","expected":["mem_b2"],"forbidden":["mem_b2_old"],"suite":"S3_temporal"}
{"qid":"q_004","kind":"abstain","lang":"zh","query":"What was that hundred-billion-parameter model I mentioned last time?","expected":[],"suite":"S6_abstain"}
{"qid":"q_005","kind":"zh-en","lang":"zh","query":"When is the deadline?","expected":["mem_en3"],"suite":"S8_bilingual"}
```

### C.3 Scenario matrix (fixed seed, parameterized scale)

| Suite | Scenario | Corpus size | Queries | Assertions (initial gates) |
|---|---|---|---|---|
| **S1_profile** | User profile / preferences (stable, heavily pinned) | 30 user records | 25 | Recall@10 ≥ 0.95, pinned hit rate 100% |
| **S2_project** | Project facts / constraints (scoped) | 200 records | 40 | Recall@10 ≥ 0.90; cross-project false recalls = 0 |
| **S3_temporal** | Temporal updates / contradictions (new value supersedes old) | 120 records (including 40 supersede pairs) | 40 | New value Recall@3 ≥ 0.90; `forbidden` old value in top3 ≤ 5% |
| **S4_forget** | Explicit `forget` / `delete` | 60 records | 20 | Recall of forgotten ids = 0 (including two-hop link paths) |
| **S5_multihop** | Multi-hop (two memories combine for an answer) | 300 records (60 linked pairs) | 30 | Two-hop Recall@10 ≥ 0.70 (the same injection must contain both ids) |
| **S6_abstain** | Negative samples / abstention (not in the store) | 1000 distractor records | 40 | False injection rate ≤ 5% (emit an empty or low-score injection) |
| **S7_distractor** | Noisy distractors (near-synonyms that are not the answer) | 5000 records (1 true + 9 near-synonyms) | 50 | Precision@1 ≥ 0.75; noise in top10 ≤ 3 |
| **S8_bilingual** | Chinese query hitting an English memory & vice versa | 500 mixed records | 40 | Cross-lingual Recall@10 ≥ 0.70 (via bilingual tags/descriptions) |
| **S9_longtail** | 10k+ synthetic pool (long tail / repeated entities) | 10,000 records | 200 | Build ≤ 200 ms; search p95 ≤ 5 ms; Recall@10 ≥ 0.85 |
| **S10_consolidate** | Near-duplicate merge correctness | 400 records (100 near-duplicate groups) | 30 | DedupRate ≥ 0.95; OverMergeRate ≤ 2% |
| **S11_noisy_text** | Typos / truncation / overlong (>2k chars) memories | 200 records | 30 | Recall@10 ≥ 0.70; must not crash (a 4k-char record) |
| **S12_budget** | Injection budget (tokens/items) | S9 pool | 50 | Injected tokens p95 ≤ 1200; pinned entries never squeezed out |

### C.4 Metrics and gates (directly expressible as assertions)

```text
# Per-suite output
{suite, n, recall@k, precision@1, mrr, ndcg@10, hit@k,
 abstain_fp_rate, forbidden_leak_rate, dedup_rate, over_merge_rate,
 forget_precision, stale_rate, index_bytes, index_overhead,
 latency_search: {p50,p95,max}, latency_inject: {p50,p95}, token_cost: {mean,p95}}

# Aggregate gates (CI failure conditions, deliberately loose at first)
recall@10(overall)      ≥ 0.88
recall@10(S1,S2)       ≥ 0.92
mrr                    ≥ 0.72
ndcg@10                ≥ 0.65
precision@1(S7)        ≥ 0.75
abstain_fp_rate(S6)    ≤ 0.05
forbidden_leak(S3)     ≤ 0.05
dedup_rate(S10)        ≥ 0.95  and over_merge ≤ 0.02
forget_precision(S4)   = 1.00   (missing a deletion is not allowed)
index_overhead         ≤ 0.60   (index bytes / body bytes, including manifest)
latency_search.p95     ≤ 5 ms @10k in-memory index (measured 0.28 ms locally, 15× headroom)
latency_inject.p95     ≤ 50 ms (disk reads + filtering + packing)
token_cost.p95         ≤ 1200
Chinese vs English recall gap ≤ 0.10  (a fairness check)
```
**Aggregation rule**: macro-average (each suite equally weighted) so S9's 200 queries cannot drown S1's 25; also report micro (weighted by query count) for reference. Report both, never only the flattering one.

### C.5 Synthetic corpus generator (deterministic)
```text
fixed seed (e.g. 20261020) → LCG: s ← (1103515245·s + 12345) mod 2^31
the generator emits three entity classes: user profile / project facts / volatile state
each "ground truth" memory gets 1..3 near-synonym distractors + 0..2 superseded history records
Chinese lexicon provided by evals/data/lexicon.zh.txt (~2000 words, domain-tagged)
English lexicon likewise; bilingual pairs via a {zh,en} word map (no translation model call)
each generation emits manifest.json (seed, lexicon hash, generator version) → results are reproducible
```
> Key point: **the generator is decoupled from the retrieval implementation**. Evaluation reads only `memories.jsonl + queries.jsonl` and never imports production code; a separate small "golden ids" set (30 hand-picked pairs) guards against generator bias.

### C.6 Optional LLM-judge QA evaluation (run only inside a harness)
```text
1 Question generation: sample 200 memories from the 10k pool and have the harness model generate "how would a user ask"; keep the 1 of 3 candidates with the lowest token overlap against the source (avoid copying the original)
2 Run: harnmem injects top-8 → the model answers → record {qid, injected_ids, answer, tokens, latency}
3 Scoring: per the 2-point rubric in A.6, judge = a different model family, temperature=0, 3 independent runs
4 Statistics: mean ± t_{0.975,2}·s/√3 (n=3, t=4.303); also report run-to-run agreement and κ
5 Sample size: a 50-question pilot estimates variance; the 200-question main run resolves roughly ±0.07 accuracy for a ±0.05 effect (rough estimate; use the actual variance)
6 Cost: 200 questions × (1200 injection + 500 question + 300 answer) tokens ≈ 0.4M tokens/round;
        3 rounds + 3 judge passes ≈ 1.2M + 0.3M ≈ **1.5M tokens per full run** (convert with the provider's unit price)
```
**Ablation matrix (change exactly one item at a time)**

| Id | Configuration | Purpose |
|---|---|---|
| A0 | keyword grep only (baseline) | Lower bound |
| A1 | +BM25 (before three-way fusion) | BM25 increment |
| A2 | +CJK bigram/BM25F field weights | Tokenization gain |
| A3 | +field signals (imp/conf/pin/used/recency) | Scoring gain |
| A4 | +two-hop link diffusion | multi-hop gain |
| A5 | +MMR de-duplication + budget packing | Injection quality/cost |
| A6 | +automatic recall (session-start injection) | End-to-end recall gain |
| A7 | +consolidation (dedupe/supersede) | Store size/conflict correctness |
| A8 | +optional rerank (LLM) | Upper-bound reference, off by default |

### C.7 Public benchmarks: how far we can realistically go (honest assessment)

| Benchmark | Runnable? | What it takes | Rough cost | What we may claim |
|---|---|---|---|---|
| **LoCoMo (retrieval-only)** | ✅ most realistic | Official 10 conversations + QA evidence labels; we compute only R@k/MRR/nDCG after mapping evidence turns→memories, **no LLM** | data <50MB; CPU minutes | "on LoCoMo retrieval-stage metrics…" (not end-to-end QA scores) |
| **LongMemEval (retrieval-only)** | ✅ second most realistic | 500 questions + extensible histories; must construct memory units ourselves (session decomposition) → 1–2 person-days | same as above | "retrieval-stage R@k/nDCG@10"; never QA accuracy |
| **LongMemEval (end-to-end)** | ⚠️ needs an LLM | judge of the GPT-4o class; 500 questions × long context (~115K) | 500×3 runs×(~115K in + 0.3K out) ≈ **170M+ tokens**, and long-context unit prices are high → tens to hundreds of dollars | only after a judge budget is approved |
| **MemoryAgentBench** | ⚠️ heavy | incremental multi-turn framework + 4-competency harness; porting ≥ 3 person-days | medium-high | not for now |
| **MemBench** | ⚠️ medium | dataset + ROUGE/LLM judging | medium | optional, lower priority than LoCoMo |

**Forbidden claims**: ❌ "beats mem0/Zep on LoCoMo" (no equivalent judge/subset) ❌ "SOTA" ❌ cross-paper number splicing.
**Allowed claims**: ✅ retrieval-stage metrics on an offline synthetic set plus reproducible scripts; ✅ relative gains over the A0/A1 baselines; ✅ separate Chinese/English results; ✅ 10k-scale latency/token cost.

---

## Part D · SQLite / FTS5 feasibility (measured on the development host)

### D.1 Runtime matrix

| Runtime | Version | `node:sqlite` | FTS5 | Notes |
|---|---|---|---|---|
| **Host Node** | v24.9.0 | ✅ no flag (prints ExperimentalWarning; `--no-experimental-sqlite` disables it) | ✅ `ENABLE_FTS5` | SQLite **3.50.4**; `node --help` lists `--no-experimental-sqlite` |
| Node 22.13–25.x | — | ✅ no flag (still ExperimentalWarning) | ✅ (same as official builds) | 22.5–22.12 require `--experimental-sqlite` |
| **pi** | 1.3.0 (requires Node ≥22.19) | ✅ uses Node | ✅ | pi is a Node package; `pi.ps1` lives in `C:\Program Files\nodejs\` |
| **DSH (Electron)** | Electron **44.7.0** / Node **24.21.0** / SQLite **3.53.4** | ✅ measured `require('node:sqlite')` OK (ELECTRON_RUN_AS_NODE) | ✅ same Node build | Electron only fixed the `node:sqlite` builtin in **≥36.7.3** (PR #47706); Electron 32 does not have it |
| **Claude Code (Bun)** | **Bun (Rust port)** runtime since v2.1.181+ | ❌ Bun's docs state **`node:sqlite` is unimplemented** | only `bun:sqlite` | see `bun.com/reference/node/sqlite`; FTS5 availability in bun:sqlite depends on the build (Apple SQLite on macOS; statically linked on Windows), so it **must be probed at runtime** |

### D.2 Measured output (verbatim excerpts)

```text
node -v → v24.9.0
require('node:sqlite').DatabaseSync  → OK (no flag)
sqlite_version()                     → 3.50.4
pragma_compile_options contains      → ENABLE_FTS3, ENABLE_FTS3_PARENTHESIS, ENABLE_FTS5,
                                       ENABLE_RTREE, ENABLE_GEOPOLY, ENABLE_DBSTAT_VTAB, ...
create virtual table t using fts5(content)                   → OK
insert 'hello world' / '记忆 系统 长期记忆'                    → OK
match 'hello' → [1] ; 'memory OR fox' → [1,3] ; '"quick brown"' → [3] ; 'mem*' → [1]
bm25(t) on 'hello' → -0.49250916713693127                     → OK
tokenize='trigram' create → OK ; tokenize='unicode61'/'porter ascii' → OK
external content table content='base', content_rowid='id' + 'rebuild'     → OK (rowid hits are correct)
db_size_bytes → 126976 (4-row small table)
Electron 44.7.0: process.versions.node=24.21.0, sqlite=3.53.4, node:sqlite DatabaseSync=function ✅
```

### D.3 The measured Chinese tokenization pitfall (critical)

| Tokenizer | `用户偏好` | `偏好` | `简洁` | `长期记忆` | `记忆` | 2-char Chinese query |
|---|---|---|---|---|---|---|
| default / unicode61 | ✅ (one token for the whole run) | ❌ | ✅ (only as a standalone token) | ❌ (whole run) | ❌ | depends on whitespace tokenization |
| porter | same as above (CJK is unaffected by stemming) | ❌ | ✅ | ❌ | ❌ | same as above |
| **trigram** | ✅ (≥3 chars) | ❌ | ❌ (2 chars) | ✅ | ❌ (2 chars) | **unusable** |

`fts5vocab` shows the default tokenization directly: `"用户偏好"`, `"长期记忆系统测试"`, `"喜欢简洁的回答"` all become **a single token** → Chinese must be **bigram-tokenized by us before writing** (see B.8): store `"用户 户偏 偏好"` in the FTS column, apply the same bigramming at query time, and join terms with `OR`.

### D.4 10k-memory measurement (same corpus, two backends, k=10)

```text
N=10000, avgDocTokens=14.4, vocab=4472
pure-JS inverted index: build 45.2 ms | search p50 0.11 ms | p95 0.28 ms | max 0.76 ms
FTS5 (bigram pre-tokenized): build 60.7 ms | search p50 0.58 ms | p95 1.17 ms | max 1.34 ms
top-3 results: JS [mem-123, mem-738, mem-1326] == FTS5 same order (identical)
index size: JS key-table JSON ~25.5 KB (excluding postings); FTS5 on-disk file 1.73 MB (10k rows)
```
**Interpretation**: at the 10k scale pure JS is already 2–5× faster and saves memory with no binary dependency; FTS5's advantage only shows up at **larger scale (100k+) / memory-constrained environments / when an on-disk, incrementally updated index is required**.

### D.5 Conclusion and recommendation (for the architecture decision)

1. **Pure-JS index by default** (`index/*.json` or an in-memory Map, rebuilt from `memories/**.md`). Reasons: zero dependencies, works across harnesses (Node/Bun/Electron), fast enough, and FTS5 would still need our own Chinese tokenization (no work saved).
2. **FTS5 as an optional accelerator**, enabled via **capability detection**:
   ```ts
   // Probe order: node:sqlite(FTS5) → bun:sqlite(FTS5) → pure JS
   async function detectFts5(): Promise<'node' | 'bun' | null> {
     try {
       const { DatabaseSync } = await import('node:sqlite');   // Node ≥22.13 / Electron ≥36.7.3
       const db = new DatabaseSync(':memory:');
       db.exec("create virtual table p using fts5(x)");          // probes the FTS5 compile option
       db.close(); return 'node';
     } catch {}
     try {
       const { Database } = await import('bun:sqlite');         // Claude Code's Bun
       const db = new Database(':memory:');
       db.run("create virtual table p using fts5(x)");           // Windows builds may lack FTS5
       db.close(); return 'bun';
     } catch { return null; }                                    // fall back to pure JS
   }
   ```
   Failures must **fall back silently** (the index is derived data; a missing backend must never block memory reads/writes).
3. **Minimum supported versions**: the core library declares `engines.node >= 18` (no builtin-module dependency beyond `fs/path`); the pi adapter follows pi's requirement of **≥22.19**; DSH ships Electron 44 (Node 24.21) and needs no handling; Claude Code uses the `bun:sqlite` branch or pure JS.
4. **Do not** put SQLite in the SSOT: `.db` is binary, not diffable, and prone to conflicts when syncing across machines → conflicts with the "plain-file SSOT" principle. The `index/` directory may hold `*.json`, and may also hold an `index.db` (**as long as the manifest marks it rebuildable and it is rebuilt automatically when missing**).
5. To support 100k+ memories: prefer **sharding + loading only active shards** (tiered JSON) over introducing SQLite, as that better matches the project constraints; FTS5 is a third-tier optimization.

---

## References (sources actually accessed/cited in this report)

**Benchmarks and papers**
- LoCoMo — Maharana et al., 2024: https://arxiv.org/abs/2402.17753
- LongMemEval — Wu et al., ICLR 2025: https://arxiv.org/abs/2410.10813 · https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html
- MemoryAgentBench — Hu & Wang et al., 2025: https://arxiv.org/abs/2507.05257
- MemBench — Tan et al., ACL 2025 Findings: https://aclanthology.org/2025.findings-acl.989/ · code https://github.com/import-myself/Membench
- MemOS — Li et al., 2025: https://arxiv.org/abs/2507.03724
- Mem0 — Chhikara et al., 2025: https://arxiv.org/abs/2504.19413
- Zep / Graphiti — Rasmussen et al., 2025: https://arxiv.org/abs/2501.13956
- A-MEM — Xu et al., NeurIPS 2025: https://arxiv.org/abs/2502.12110
- Generative Agents — Park et al., 2023: https://arxiv.org/abs/2304.03442 · https://dl.acm.org/doi/10.1145/3586183.3606763
- MemoryBank — Zhong et al., AAAI 2024: https://arxiv.org/abs/2305.10250 · https://ojs.aaai.org/index.php/AAAI/article/download/29946/31654 (original source of R=e^{-t/S})
- MemGPT / Letta — Packer et al., 2023: https://arxiv.org/abs/2310.08560
- HippoRAG — Gutiérrez et al., NeurIPS 2024: https://arxiv.org/abs/2405.14831
- LLM-as-a-judge (MT-Bench) — Zheng et al., 2023: https://arxiv.org/abs/2306.05685
- Survey "Memory in the Age of AI Agents": https://arxiv.org/abs/2512.13564
- Survey "From Human Memory to AI Memory": https://arxiv.org/abs/2504.15965

**Engineering/runtime**
- Node.js `node:sqlite` docs (flag history: 22.5–22.12 need `--experimental-sqlite`; 22.13+ do not): https://nodejs.org/api/sqlite.html
- Electron fix for the `node:sqlite` builtin (36.7.3/37/38): https://github.com/electron/electron/pull/47706 · https://releases.electronjs.org/release/v36.7.3
- Bun does not implement `node:sqlite` (use `bun:sqlite`): https://bun.com/reference/node/sqlite
- Bun `bun:sqlite` docs (macOS uses the system SQLite; extension/build differences): https://bun.com/docs/api/sqlite
- Claude Code uses Bun (Rust port, v2.1.181+): https://simonwillison.net/2026/jul/19/claude-code-in-bun-in-rust/

**Classic IR (no stable public URL; cited by publication)**
- BM25: Robertson & Zaragoza, "The Probabilistic Relevance Framework: BM25 and Beyond", FnTIR 2009; BM25+: Lv & Zhai, CIKM 2011; BM25F: Robertson, Zaragoza & Taylor, 2004
- RRF: Cormack, Clarke & Buettcher, "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods", SIGIR 2009 (k=60)
- SimHash: Charikar, STOC 2002; Manku, Jain & Sarma, WWW 2007 (near-duplicate detection)
- MinHash/LSH: Broder, 1997; Indyk & Motwani, STOC 1998

---
*All "measured" numbers in this report are one-off probe results from the development host (scripts under `%TEMP%/harnmem_fts/`, not repository artifacts); rerun the 10k synthetic corpus before comparing.*
