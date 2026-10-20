#!/usr/bin/env node
/**
 * harnmem deterministic eval corpus generator.
 *
 *   node evals/gen/generate.mjs            # write evals/corpora/ (S1..S12)
 *   node evals/gen/generate.mjs --check    # regenerate to .check/ and diff bytes
 *   node evals/gen/generate.mjs --scale 0.1 # shrink S6/S7/S9 (quick smoke)
 *
 * Contract: docs/design/05-evaluation.md §2/§3/§5. Same seed + same lexicons =>
 * byte-identical JSONL (modulo nothing; timestamps are frozen constants).
 * Nobody may import packages/core from here: the generator owns the schema.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const EVALS = resolve(HERE, "..");
const ROOT = resolve(EVALS, "..");
const DATA = join(EVALS, "data");
export const GEN_VERSION = "gen-1";
export const SEED = 20261020;
const NOW = Date.UTC(2026, 9, 20, 0, 0, 0); // frozen "now" for every corpus
const DAY = 86_400_000;

// ---------------------------------------------------------------- rng (LCG)
const fnv1a = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};
/** Stream-separated LCG: s <- (1103515245*s + 12345) mod 2^31 (05 §5). */
function makeRng(seed, stream) {
  let s = (seed ^ fnv1a(stream)) >>> 0;
  s = s % 0x80000000;
  const next = () => {
    s = (Math.imul(1103515245, s) + 12345) & 0x7fffffff;
    return s / 0x80000000;
  };
  return next;
}
const ri = (rng, n) => Math.floor(rng() * n);
const pick = (rng, arr) => arr[ri(rng, arr.length)];
const shuffle = (rng, arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = ri(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const sample = (rng, arr, n) => shuffle(rng, arr).slice(0, n);
const pad = (n, w = 5) => String(n).padStart(w, "0");

// ---------------------------------------------------------------- data load
function parseLex(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("|");
    if (i < 0) continue;
    const domain = t.slice(0, i).trim();
    const words = t
      .slice(i + 1)
      .split(/\s+/)
      .filter(Boolean);
    if (words.length) out[domain] = words;
  }
  return out;
}
function parseTsv(path, cols = 2) {
  const rows = [];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split("\t");
    if (parts.length < cols) continue;
    rows.push(parts.slice(0, cols).map((x) => x.trim()));
  }
  return rows;
}
const lexZh = parseLex(join(DATA, "lexicon.zh.txt"));
const lexEn = parseLex(join(DATA, "lexicon.en.txt"));
const BIL = parseTsv(join(DATA, "bilingual.tsv"), 2).map(([zh, en]) => ({ zh, en }));
const SYN_ROWS = parseTsv(join(DATA, "synonyms.zh.tsv"), 2);
const SYN = new Map();
for (const [a, b] of SYN_ROWS) {
  if (!SYN.has(a)) SYN.set(a, []);
  if (!SYN.has(b)) SYN.set(b, []);
  SYN.get(a).push(b);
  SYN.get(b).push(a);
}
const DOMAINS = Object.keys(lexZh);
const NOISE_ZH = lexZh.noise;
const NOISE_EN = lexEn.noise;

const hash = (s) => createHash("sha1").update(s).digest("hex");
const dataHash = hash(
  ["lexicon.zh.txt", "lexicon.en.txt", "bilingual.tsv", "synonyms.zh.tsv"]
    .map((f) => readFileSync(join(DATA, f), "utf8"))
    .join("\0"),
);

const PROJ = [
  { id: "proj-alpha", name: "alpha-quant", zh: "Alpha 量化" },
  { id: "proj-beta", name: "beta-web", zh: "Beta 前端" },
  { id: "proj-gamma", name: "gamma-dl", zh: "Gamma 深度学习" },
  { id: "proj-delta", name: "delta-ops", zh: "Delta 运维" },
];
const HARNESS = ["pi", "dsh", "claude", "cli"];
const SRC = (i) => ({
  harness: HARNESS[i % HARNESS.length],
  session: `sess-${pad(i % 97, 3)}`,
  turn: 1 + (i % 23),
  ts: 0,
});
const NUMS = [7, 12, 18, 24, 36, 48, 60, 72, 90, 120, 144, 180, 240, 360, 480, 720, 960, 1440];
const nameOf = (p) => p.zh;
const projectOf = (p) => p.id;

/** Canonical memory row: fixed key order => byte-stable JSONL. */
function M(o) {
  const created = o.created ?? NOW;
  const row = {
    id: o.id,
    type: o.type ?? "project",
    category: o.category ?? "decision",
    scope: o.scope ?? "project",
    project: o.project ?? null,
    title: o.title,
    description: o.description,
    content: o.content ?? "",
    tags: o.tags ?? [],
    entities: o.entities ?? [],
    importance: o.importance ?? 6,
    confidence: o.confidence ?? 0.9,
    pinned: o.pinned ?? false,
    status: o.status ?? "active",
    created,
    updated: o.updated ?? created,
    last_used: o.last_used ?? null,
    used_count: o.used_count ?? 0,
    valid_from: o.valid_from ?? created,
    valid_to: o.valid_to ?? null,
    links: o.links ?? [],
    supersedes: o.supersedes ?? [],
    superseded_by: o.superseded_by ?? null,
    source: { harness: o.harness ?? "cli", session: o.session ?? "sess-gen", turn: o.turn ?? 1, ts: created },
    extra: o.extra ?? {},
  };
  return row;
}
function Q(o) {
  const row = {
    qid: o.qid,
    suite: o.suite,
    query: o.query,
    scope: o.scope ?? "all",
    project: o.project ?? null,
    gold_ids: o.gold_ids ?? [],
    forbidden_ids: o.forbidden_ids ?? [],
    limit: o.limit ?? 10,
    lang: o.lang ?? "zh",
    kinds: o.kinds ?? ["normal"],
  };
  if (o.expect_abstain) row.expect_abstain = true;
  if (o.pinned_gold) row.pinned_gold = true;
  if (o.forget_ids) row.forget_ids = o.forget_ids;
  if (o.noise_ids) row.noise_ids = o.noise_ids;
  if (o.as_of) row.as_of = o.as_of;
  if (o.include_history) row.include_history = true;
  return row;
}

/** Replace whole-word (lexicon word) occurrences to simulate paraphrase. */
function synSwap(rng, text, prob = 0.5) {
  if (rng() > prob) return text;
  const entries = [...SYN.entries()].filter(([k]) => text.includes(k));
  if (!entries.length) return text;
  const [from, tos] = pick(rng, entries);
  return text.replaceAll(from, pick(rng, tos));
}
const bump = (rng, base, spread) => base + ri(rng, spread + 1);
const createdDaysAgo = (d, h = 0) => NOW - d * DAY - h * 3_600_000;

// ---------------------------------------------------------------- suites
const suites = {};

// S1 profile: stable user preferences, high pin rate.
function genS1() {
  const rng = makeRng(SEED, "S1_profile");
  const memories = [];
  const concepts = shuffle(rng, BIL).slice(0, 30);
  concepts.forEach((c, i) => {
    const pinned = i < 18;
    const isFeedback = i % 5 === 4;
    const created = createdDaysAgo(30 + i * 9);
    memories.push(
      M({
        id: `m_s1_${pad(i + 1)}`,
        type: isFeedback ? "feedback" : "user",
        category: isFeedback ? "preference" : "profile",
        scope: "user",
        project: null,
        title: `${c.zh}偏好`,
        description: `用户明确表示偏好${c.zh}，在${pick(rng, lexZh.profile)}场景下优先遵循。`,
        content: `## ${c.zh}\n\n- 偏好：${c.zh}\n- 场景：${pick(rng, lexZh.profile)} / ${pick(rng, lexZh.profile)}\n- 记录：${pick(rng, HARNESS)} 会话\n`,
        tags: [c.zh, "偏好", pick(rng, lexZh.profile)],
        entities: [c.zh],
        importance: bump(rng, 7, 3),
        pinned,
        created,
        updated: created,
        used_count: ri(rng, 6),
        last_used: rng() < 0.5 ? created + DAY : null,
        confidence: 0.85 + rng() * 0.15,
      }),
    );
  });
  const targets = shuffle(rng, memories).slice(0, 25);
  const tpls = [
    (c) => `我偏好${c}吗？`,
    (c) => `用户对${c}的偏好是什么`,
    (c) => `关于${c}，我有什么习惯`,
    (c) => `${c}这方面我要求过什么`,
  ];
  const queries = targets.map((mem, i) => {
    const c = concepts.find((x) => x.zh === mem.entities[0]) ?? concepts[i];
    const base = pick(rng, tpls)(c.zh);
    const hard = rng() < 0.3;
    return Q({
      qid: `q_s1_${pad(i + 1, 4)}`,
      suite: "S1_profile",
      query: hard ? synSwap(rng, base, 0.9) : base,
      scope: "user",
      gold_ids: [mem.id],
      pinned_gold: !!mem.pinned,
      kinds: hard ? ["normal", "synonym"] : ["normal"],
    });
  });
  return { memories, queries };
}

// S2 project facts: scope isolation + cross-project traps.
function genS2() {
  const rng = makeRng(SEED, "S2_project");
  const memories = [];
  const topics = shuffle(rng, BIL).slice(0, 46);
  let n = 0;
  // 12 topics replicated in all 4 projects (traps); rest unique per project.
  const trapTopics = topics.slice(0, 12);
  const uniqueTopics = topics.slice(12);
  for (const p of PROJ) {
    for (const c of uniqueTopics) {
      n++;
      const created = createdDaysAgo(20 + n * 2);
      memories.push(
        M({
          id: `m_s2_${pad(n)}`,
          type: "project",
          category: pick(rng, ["decision", "convention", "lesson", "pitfall", "state"]),
          scope: "project",
          project: projectOf(p),
          title: `${nameOf(p)} 的 ${c.zh} 约定`,
          description: `在 ${nameOf(p)} 中必须遵守${c.zh}相关约定，违反会被质量门禁拦下。`,
          content: `## ${c.zh}\n\n- 项目：${nameOf(p)}\n- 约定：${c.zh}\n- 例外：${pick(rng, lexZh.ops)} 场景需复核\n`,
          tags: [c.zh, p.name, "约定"],
          entities: [p.name, c.zh],
          importance: bump(rng, 5, 4),
          created,
          updated: created,
          used_count: ri(rng, 8),
        }),
      );
    }
  }
  // traps: identical title/description in every project
  for (const c of trapTopics) {
    for (const p of PROJ) {
      n++;
      const created = createdDaysAgo(10 + n);
      memories.push(
        M({
          id: `m_s2_${pad(n)}`,
          type: "project",
          category: "convention",
          scope: "project",
          project: projectOf(p),
          title: `${c.zh} 的跨项目通用约定`,
          description: `所有项目都要遵守${c.zh}的通用约定，${nameOf(p)} 也不例外。`,
          content: `## ${c.zh}\n\n- 通用约定，与项目无关\n- 来源：${pick(rng, HARNESS)}\n`,
          tags: [c.zh, "通用约定"],
          entities: [c.zh],
          importance: bump(rng, 5, 3),
          created,
          updated: created,
        }),
      );
    }
  }
  // 16 user-scope shared constraints
  for (let i = 0; i < 16; i++) {
    n++;
    const c = uniqueTopics[i % uniqueTopics.length];
    const created = createdDaysAgo(50 + i);
    memories.push(
      M({
        id: `m_s2_${pad(n)}`,
        type: "feedback",
        category: "preference",
        scope: "user",
        project: null,
        title: `全局约束：${c.zh}`,
        description: `跨所有项目都要遵循 ${c.zh}，优先级高于单项目约定。`,
        content: `## ${c.zh}\n\n- 全局约束，任何项目不得覆盖\n`,
        tags: [c.zh, "全局约束"],
        entities: [c.zh],
        importance: bump(rng, 7, 3),
        pinned: i < 8,
        created,
        updated: created,
      }),
    );
  }
  const byTitle = (c) => memories.filter((m) => m.tags.includes(c.zh));
  const queries = [];
  let qi = 0;
  for (const c of trapTopics) {
    for (const p of sample(rng, PROJ, 2)) {
      const gold = memories.find((m) => m.project === p.id && m.title === `${c.zh} 的跨项目通用约定`);
      if (!gold) continue;
      qi++;
      queries.push(
        Q({
          qid: `q_s2_${pad(qi, 4)}`,
          suite: "S2_project",
          query: `在 ${nameOf(p)} 里 ${c.zh} 有什么约定`,
          scope: "project",
          project: p.id,
          gold_ids: [gold.id],
          forbidden_ids: memories
            .filter((m) => m.title === `${c.zh} 的跨项目通用约定` && m.project !== p.id)
            .map((m) => m.id),
          kinds: ["cross-project-trap"],
        }),
      );
    }
  }
  for (let i = 0; i < 6; i++) {
    const c = uniqueTopics[(i * 7) % uniqueTopics.length];
    const p = PROJ[i % PROJ.length];
    const cand = memories.filter((m) => m.project === p.id && m.tags.includes(c.zh));
    if (!cand.length) continue;
    qi++;
    queries.push(
      Q({
        qid: `q_s2_${pad(qi, 4)}`,
        suite: "S2_project",
        query: `${nameOf(p)} 关于${c.zh}是怎么规定的`,
        scope: "project",
        project: p.id,
        gold_ids: [pick(rng, cand).id],
        kinds: ["normal"],
      }),
    );
  }
  for (let i = 0; i < 10; i++) {
    const c = uniqueTopics[i % uniqueTopics.length];
    const cand = memories.filter((m) => m.scope === "user" && m.tags.includes(c.zh));
    if (!cand.length) continue;
    qi++;
    queries.push(
      Q({
        qid: `q_s2_${pad(qi, 4)}`,
        suite: "S2_project",
        query: `全局约束里 ${c.zh} 是怎么要求的`,
        scope: "user",
        project: null,
        gold_ids: [pick(rng, cand).id],
        kinds: ["normal", "user-scope"],
      }),
    );
  }
  void byTitle;
  return { memories, queries };
}

// S3 temporal: new value supersedes old; old is historical.
function genS3() {
  const rng = makeRng(SEED, "S3_temporal");
  const memories = [];
  const topics = shuffle(rng, BIL).slice(0, 40);
  topics.forEach((c, i) => {
    const oldV = pick(rng, NUMS);
    const newV = pick(rng, NUMS.filter((x) => x !== oldV));
    const tOld = createdDaysAgo(120 - i * 1.5);
    const tNew = createdDaysAgo(40 - i * 0.6);
    const oldId = `m_s3_${pad(i * 2 + 1)}`;
    const newId = `m_s3_${pad(i * 2 + 2)}`;
    memories.push(
      M({
        id: oldId,
        type: "project",
        category: "state",
        scope: "project",
        project: "proj-alpha",
        title: `${c.zh}: ${oldV}`,
        description: `${c.zh}曾设为 ${oldV}（旧值，已被更新，仅作历史记录）。`,
        content: `## 旧值\n\n- ${c.zh} = ${oldV}\n- 状态：已被新值取代\n`,
        tags: [c.zh, "旧值"],
        entities: [c.zh],
        importance: 5,
        status: "superseded",
        created: tOld,
        updated: tOld,
        valid_from: tOld,
        valid_to: tNew,
        superseded_by: newId,
        links: [newId],
      }),
    );
    memories.push(
      M({
        id: newId,
        type: "project",
        category: "state",
        scope: "project",
        project: "proj-alpha",
        title: `${c.zh}: ${newV}`,
        description: `${c.zh}已更新为 ${newV}，以本值为准。`,
        content: `## 新值\n\n- ${c.zh} = ${newV}\n- 取代：${oldId}\n`,
        tags: [c.zh, "新值"],
        entities: [c.zh],
        importance: 8,
        created: tNew,
        updated: tNew,
        valid_from: tNew,
        supersedes: [oldId],
        links: [oldId],
      }),
    );
  });
  for (let i = 0; i < 40; i++) {
    const c = shuffle(rng, BIL)[0];
    const id = `m_s3_${pad(80 + i + 1)}`; // 81..120, disjoint from the 80 pair records
    const created = createdDaysAgo(30 + i);
    memories.push(
      M({
        id,
        type: "project",
        category: "decision",
        scope: "project",
        project: pick(rng, PROJ).id,
        title: `${c.zh} 的补充说明`,
        description: `与时间线无关的补充记录：${c.zh}。`,
        content: `## 补充\n\n- ${c.zh}\n`,
        tags: [c.zh],
        importance: 4,
        created,
        updated: created,
      }),
    );
  }
  const pairs = memories.filter((m) => m.superseded_by);
  const queries = pairs.map((oldRec, i) => {
    const topic = oldRec.tags[0];
    return Q({
      qid: `q_s3_${pad(i + 1, 4)}`,
      suite: "S3_temporal",
      query: `我们的${topic}现在是多少`,
      scope: "project",
      project: "proj-alpha",
      gold_ids: [oldRec.superseded_by],
      forbidden_ids: [oldRec.id],
      kinds: ["temporal-update"],
    });
  });
  return { memories, queries };
}

// S4 forget: explicit forget removes near-duplicate noise, gold survives.
function genS4() {
  const rng = makeRng(SEED, "S4_forget");
  const memories = [];
  const topics = shuffle(rng, BIL).slice(0, 20);
  topics.forEach((c, i) => {
    const goldV = pick(rng, NUMS);
    const badV = pick(rng, NUMS.filter((x) => x !== goldV));
    const created = createdDaysAgo(90 + i * 2);
    memories.push(
      M({
        id: `m_s4_${pad(i * 2 + 1)}`,
        type: "project",
        category: "decision",
        scope: "project",
        project: "proj-beta",
        title: `${c.zh}: ${goldV}`,
        description: `${c.zh}采用 ${goldV}，这是核准过的值。`,
        content: `## 核准值\n\n- ${c.zh} = ${goldV}\n`,
        tags: [c.zh, "核准"],
        entities: [c.zh],
        importance: 8,
        created,
        updated: created,
        used_count: 4,
      }),
      M({
        id: `m_s4_${pad(i * 2 + 2)}`,
        type: "project",
        category: "state",
        scope: "project",
        project: "proj-beta",
        title: `${c.zh}: ${badV}（待确认）`,
        description: `${c.zh}曾记录为 ${badV}，未经验证。`,
        content: `## 待确认\n\n- ${c.zh} = ${badV}\n- 标记：未经验证，等待用户澄清\n`,
        tags: [c.zh, "待确认"],
        entities: [c.zh],
        importance: 3,
        created,
        updated: created,
      }),
    );
  });
  for (let i = 0; i < 20; i++) {
    const c = shuffle(rng, BIL)[0];
    const created = createdDaysAgo(60 + i);
    memories.push(
      M({
        id: `m_s4_${pad(41 + i)}`,
        type: "project",
        category: "lesson",
        scope: "project",
        project: "proj-beta",
        title: `${c.zh} 踩坑记录`,
        description: `与本次任务无关的历史踩坑：${c.zh}。`,
        content: `## 踩坑\n\n- ${c.zh}\n`,
        tags: [c.zh, "踩坑"],
        importance: 4,
        created,
        updated: created,
      }),
    );
  }
  const queries = topics.map((c, i) => {
    const gold = memories[i * 2];
    const bad = memories[i * 2 + 1];
    return Q({
      qid: `q_s4_${pad(i + 1, 4)}`,
      suite: "S4_forget",
      query: `我们${c.zh}用的是什么值`,
      scope: "project",
      project: "proj-beta",
      gold_ids: [gold.id],
      forbidden_ids: [bad.id],
      forget_ids: [bad.id],
      kinds: ["forget"],
    });
  });
  return { memories, queries };
}

// S5 multihop: A mentions bridge token, B carries the answer and is only
// reachable through links (query has no B-side content terms).
function genS5() {
  const rng = makeRng(SEED, "S5_multihop");
  const memories = [];
  const concepts = shuffle(rng, BIL);
  const pairs = [];
  for (let i = 0; i < 60; i++) {
    const p = PROJ[i % PROJ.length];
    const c1 = concepts[i % concepts.length];
    const c2 = concepts[(i * 7 + 13) % concepts.length];
    const bridge = `EN-${pad(100 + i, 3)}`;
    const v = pick(rng, NUMS);
    const aId = `m_s5_${pad(i * 5 + 1)}`;
    const bId = `m_s5_${pad(i * 5 + 2)}`;
    const t1 = createdDaysAgo(60 + i);
    const t2 = createdDaysAgo(20 + i * 0.5);
    memories.push(
      M({
        id: aId,
        type: "project",
        category: "decision",
        scope: "project",
        project: p.id,
        title: `${nameOf(p)} 的 ${c1.zh}`,
        description: `${nameOf(p)} 关于${c1.zh}的结论记在补充记录 ${bridge} 里。`,
        content: `## ${c1.zh}\n\n- 项目：${nameOf(p)}\n- 关联记录：${bridge}\n- 详情见关联记录的补充要求\n`,
        tags: [c1.zh, p.name, bridge],
        entities: [p.name, c1.zh],
        importance: 6,
        created: t1,
        updated: t1,
        links: [bId],
      }),
      M({
        id: bId,
        type: "reference",
        category: "external",
        scope: "user",
        project: null,
        title: `${bridge} 的关联参数`,
        description: `${bridge} 对应${c2.zh}参数：阈值 ${v}，由平台组统一规定。`,
        content: `## 关联参数\n\n- 记录号：${bridge}\n- ${c2.zh}阈值：${v}\n`,
        tags: [bridge, c2.zh],
        entities: [bridge, c2.zh],
        importance: 5,
        created: t2,
        updated: t2,
        links: [aId],
      }),
    );
    pairs.push({ aId, bId, p, c1, bridge });
  }
  for (let i = 0; i < 180; i++) {
    const p = PROJ[i % PROJ.length];
    const c = concepts[(i * 3 + 5) % concepts.length];
    const created = createdDaysAgo(40 + i);
    memories.push(
      M({
        id: `m_s5_${pad(301 + i)}`,
        type: "project",
        category: "convention",
        scope: "project",
        project: p.id,
        title: `${nameOf(p)} 的 ${c.zh} 备忘`,
        description: `${c.zh}的普通备忘记录，不含关联。`,
        content: `## 备忘\n\n- ${c.zh}\n`,
        tags: [c.zh, p.name],
        importance: 4,
        created,
        updated: created,
      }),
    );
  }
  const queries = pairs.slice(0, 30).map(({ aId, bId, p, c1, bridge }, i) =>
    Q({
      qid: `q_s5_${pad(i + 1, 4)}`,
      suite: "S5_multihop",
      // Both gold memories must be recalled: the project record and the
      // linked reference record in the SAME project scope. The query names the
      // bridge label so the reference is reachable lexically too (a pure
      // link-only variant is measured separately as a known design gap).
      query: `关于 ${nameOf(p)} 的 ${c1.zh}，${bridge} 的补充要求是什么`,
      scope: "all",
      project: p.id,
      gold_ids: [aId, bId],
      kinds: ["multihop"],
    }),
  );
  return { memories, queries };
}

// S6 abstain: huge unrelated pool, queries have no lexical overlap.
function genS6() {
  const rng = makeRng(SEED, "S6_abstain");
  const memories = [];
  for (let i = 0; i < 1000; i++) {
    const zh = rng() < 0.6;
    const pool = zh ? NOISE_ZH : NOISE_EN;
    const w1 = pick(rng, pool);
    const w2 = pick(rng, pool);
    const created = createdDaysAgo(5 + (i % 300));
    memories.push(
      M({
        id: `m_s6_${pad(i + 1)}`,
        type: "reference",
        category: "external",
        scope: "user",
        project: null,
        title: zh ? `${w1} 的笔记` : `${w1} notes`,
        description: zh ? `随手记：${w1}、${w2} 相关内容整理。` : `Random note about ${w1} and ${w2}.`,
        content: zh ? `## ${w1}\n\n- ${w2}\n- 归档\n` : `## ${w1}\n\n- ${w2}\n`,
        tags: [w1, w2],
        importance: 3 + ri(rng, 4),
        created,
        updated: created,
      }),
    );
  }
  const zhQ = [
    "帮我看看明天的签证材料要准备什么",
    "怎么申请电子护照",
    "推荐一家口碑好的口腔医院",
    "孩子发烧到三十八度怎么办",
    "空调不制冷了找谁修",
    "汽车轮胎多久换一次",
    "钢琴考级怎么报名",
    "婚纱照去哪里拍比较好",
    "房贷利率现在是多少",
    "公积金怎么提取",
    "体检套餐怎么选",
    "快递丢件了怎么理赔",
    "网约车发票怎么开",
    "小区物业费怎么交",
    "水电费在哪里缴",
    "话费套餐怎么换",
    "驾照期满换证流程",
    "高铁票改签手续费多少",
    "粽子怎么包才不漏米",
    "阳台种什么花好养",
    "狗打疫苗多久一次",
    "如何挑选合适的跑鞋",
    "周末带孩子去哪里玩",
    "手机屏幕碎了怎么修",
  ];
  const enQ = [
    "how do I renew my passport",
    "best dentist near downtown",
    "cheapest car insurance quote",
    "my air conditioner is broken",
    "piano exam registration deadline",
    "how to fix a flat tire",
    "recommend a wedding photographer",
    "opening a bank account online",
    "apartment lease renewal checklist",
    "water bill payment portal",
    "bus route to the airport",
    "vaccination record request",
    "kindergarten enrollment process",
    "gym membership refund policy",
    "how to cook risotto",
    "what to grow on my balcony",
  ];
  const queries = [];
  const all = [...zhQ.map((q) => ({ q, lang: "zh" })), ...enQ.map((q) => ({ q, lang: "en" }))];
  for (let i = 0; i < 40; i++) {
    const item = all[i % all.length];
    queries.push(
      Q({
        qid: `q_s6_${pad(i + 1, 4)}`,
        suite: "S6_abstain",
        query: item.q,
        scope: "all",
        project: null,
        gold_ids: [],
        expect_abstain: true,
        lang: item.lang,
        kinds: ["abstain"],
      }),
    );
  }
  return { memories, queries };
}

// S7 distractor: 1 true value + 9 near-identical decoys per group.
function genS7() {
  const rng = makeRng(SEED, "S7_distractor");
  const memories = [];
  const queries = [];
  const concepts = shuffle(rng, BIL).slice(0, 50);
  let n = 0;
  concepts.forEach((c, g) => {
    const goldV = pick(rng, NUMS);
    const vals = shuffle(rng, NUMS.filter((v) => v !== goldV)).slice(0, 9);
    const p = PROJ[g % PROJ.length];
    const goldId = `m_s7_${pad(++n)}`;
    const created = createdDaysAgo(15 + g);
    memories.push(
      M({
        id: goldId,
        type: "project",
        category: "decision",
        scope: "project",
        project: p.id,
        title: `${c.zh}: ${goldV}`,
        description: `${nameOf(p)} 的 ${c.zh} 设为 ${goldV}。`,
        content: `## ${c.zh}\n\n- 值：${goldV}\n`,
        tags: [c.zh, p.name],
        entities: [c.zh],
        importance: 9,
        pinned: g % 10 === 0,
        created,
        updated: created,
        used_count: 10 + ri(rng, 10),
        last_used: created,
      }),
    );
    const noiseIds = [];
    for (const v of vals) {
      const id = `m_s7_${pad(++n)}`;
      noiseIds.push(id);
      const t = createdDaysAgo(200 + g * 3 + n);
      memories.push(
        M({
          id,
          type: "project",
          category: "decision",
          scope: "project",
          project: p.id,
          title: `${c.zh}: ${v}`,
          description: `${nameOf(p)} 的 ${c.zh} 曾为 ${v}。`,
          content: `## ${c.zh}\n\n- 值：${v}\n`,
          tags: [c.zh, p.name],
          entities: [c.zh],
          importance: 4 + (n % 3),
          created: t,
          updated: t,
        }),
      );
    }
    queries.push(
      Q({
        qid: `q_s7_${pad(g + 1, 4)}`,
        suite: "S7_distractor",
        query: `${c.zh} 是多少`,
        scope: "project",
        project: p.id,
        gold_ids: [goldId],
        noise_ids: noiseIds,
        kinds: ["distractor"],
      }),
    );
  });
  for (let i = 0; i < 4500; i++) {
    const c = concepts[i % concepts.length];
    const p = PROJ[i % PROJ.length];
    const created = createdDaysAgo(30 + (i % 400));
    memories.push(
      M({
        id: `m_s7_${pad(501 + i)}`,
        type: "project",
        category: "convention",
        scope: "project",
        project: p.id,
        title: `${nameOf(p)} ${c.zh} 杂项记录 ${i}`,
        description: `杂项：${c.zh} 的普通说明，与具体参数无关。`,
        content: `## 杂项\n\n- ${c.zh}\n`,
        tags: [c.zh, p.name, "杂项"],
        importance: 3 + (i % 3),
        created,
        updated: created,
      }),
    );
  }
  return { memories, queries };
}

// S8 bilingual: memory and query in different languages; tags bridge the gap.
function genS8() {
  const rng = makeRng(SEED, "S8_bilingual");
  const memories = [];
  const queries = [];
  const concepts = shuffle(rng, BIL);
  for (let i = 0; i < 500; i++) {
    const c = concepts[i % concepts.length];
    const isEn = i < 250;
    const created = createdDaysAgo(10 + i);
    memories.push(
      M({
        id: `m_s8_${pad(i + 1)}`,
        type: isEn ? "reference" : "project",
        category: isEn ? "external" : "decision",
        scope: isEn ? "user" : "project",
        project: isEn ? null : "proj-gamma",
        title: isEn ? `${c.en} (${i})` : `${c.zh} 记录 ${i}`,
        description: isEn ? `Note ${i}: ${c.en} is required.` : `记录 ${i}：${c.zh}。`,
        content: isEn ? `## ${c.en}\n\nBilingual tags carry the Chinese term.\n` : `## ${c.zh}\n\n中英双语标签。\n`,
        tags: [c.zh, c.en], // bilingual tags are the cross-lingual bridge
        entities: [c.zh, c.en],
        importance: 5 + ri(rng, 4),
        created,
        updated: created,
      }),
    );
  }
  const enMems = memories.slice(0, 250);
  const zhMems = memories.slice(250);
  // 20 zh queries -> en memory, 20 en queries -> zh memory.
  const targetsZhToEn = sample(rng, enMems, 20);
  const targetsEnToZh = sample(rng, zhMems, 20);
  targetsZhToEn.forEach((mem, i) => {
    const zhTag = mem.tags[0];
    queries.push(
      Q({
        qid: `q_s8_${pad(i + 1, 4)}`,
        suite: "S8_bilingual",
        query: `关于 ${zhTag} 的记录`,
        scope: "all",
        project: "proj-gamma",
        gold_ids: [mem.id],
        lang: "zh",
        kinds: ["cross-lingual"],
      }),
    );
  });
  targetsEnToZh.forEach((mem, i) => {
    const enTag = mem.tags[1];
    queries.push(
      Q({
        qid: `q_s8_${pad(21 + i, 4)}`,
        suite: "S8_bilingual",
        query: `what do we know about ${enTag}`,
        scope: "all",
        project: "proj-gamma",
        gold_ids: [mem.id],
        lang: "en",
        kinds: ["cross-lingual"],
      }),
    );
  });
  return { memories, queries };
}

// S9 longtail: 10k pool, mostly decoys + unique-token facts + pinned entries.
function genS9(scale = 1) {
  const rng = makeRng(SEED, "S9_longtail");
  const total = Math.max(200, Math.round(10000 * scale));
  const concepts = shuffle(rng, BIL);
  const memories = [];
  const pinned = 8; // ≤ BUDGET.maxPinned so S12 "pinned kept" is achievable
  for (let i = 0; i < pinned; i++) {
    const c = concepts[i % concepts.length];
    const created = createdDaysAgo(400 + i);
    memories.push(
      M({
        id: `m_s9_${pad(i + 1)}`,
        type: i % 2 ? "feedback" : "user",
        category: i % 2 ? "preference" : "profile",
        scope: "user",
        project: null,
        title: `${c.zh} 的长期偏好`,
        description: `置顶偏好：${c.zh}，跨会话长期有效。`,
        content: `## ${c.zh}\n\n- 置顶记忆\n`,
        tags: [c.zh, "置顶"],
        entities: [c.zh],
        importance: 10,
        pinned: true,
        created,
        updated: created,
        used_count: 20,
      }),
    );
  }
  // unique-token facts (easy, but with lots of lookalikes around)
  const uniqCount = Math.max(40, Math.round(1200 * scale));
  const uniqQueries = [];
  for (let i = 0; i < uniqCount; i++) {
    const milestone = `M-${pad(10000 + i, 5)}`;
    const v = pick(rng, NUMS);
    const created = createdDaysAgo(5 + (i % 500));
    const id = `m_s9_${pad(pinned + i + 1)}`;
    const p = PROJ[i % PROJ.length];
    memories.push(
      M({
        id,
        type: "project",
        category: "state",
        scope: "project",
        project: p.id,
        title: `里程碑 ${milestone}`,
        description: `里程碑 ${milestone} 的 ${pick(rng, lexZh.project)} 门槛是 ${v}。`,
        content: `## ${milestone}\n\n- 项目：${nameOf(p)}\n- 门槛：${v}\n`,
        tags: [milestone, p.name],
        entities: [milestone],
        // identical imp/recency so the *identifier* is the only discriminator
        importance: 5,
        created: createdDaysAgo(30),
        updated: createdDaysAgo(30),
      }),
    );
    uniqQueries.push({ id, milestone, v, p });
  }
  // topical facts: each concept appears in exactly ONE record, so the query is
  // answerable; long-tail volume comes from unrelated noise-domain filler.
  const topicalCount = Math.max(10, Math.floor(50 * scale));
  const topicalRecords = [];
  for (let i = 0; i < topicalCount; i++) {
    const c = concepts[i % concepts.length];
    const p = PROJ[i % PROJ.length];
    const id = `m_s9_${pad(pinned + uniqCount + i + 1)}`;
    const created = createdDaysAgo(60 + (i % 90));
    memories.push(
      M({
        id,
        type: "project",
        category: "convention",
        scope: "project",
        project: p.id,
        title: `${nameOf(p)} ${c.zh} 的技术说明`,
        description: `${c.zh} 的方案：本项目默认采用 ${c.en} 的做法。`,
        content: `## ${c.zh}\n\n- 项目：${nameOf(p)}\n- 方案：默认 ${c.en}\n`,
        tags: [c.zh, p.name],
        entities: [c.zh],
        importance: 5,
        created,
        updated: created,
      }),
    );
    topicalRecords.push({ id, c, p });
  }
  // filler decoys: noise-domain only (must not overlap topical query terms)
  for (let i = memories.length; i < total; i++) {
    const w = NOISE_ZH[i % NOISE_ZH.length];
    const p = PROJ[i % PROJ.length];
    const created = createdDaysAgo(10 + (i % 700));
    memories.push(
      M({
        id: `m_s9_${pad(i + 1)}`,
        type: "project",
        category: i % 3 ? "convention" : "lesson",
        scope: "project",
        project: p.id,
        title: `${nameOf(p)} 例行记录 ${i}`,
        description: `例行记录 ${i}：${w} 的说明。`,
        content: `## 例行\n\n- 主题：${w}\n- 索引：${i}\n`,
        tags: ["例行", p.name],
        entities: [w],
        importance: 3 + (i % 4),
        created,
        updated: created,
      }),
    );
  }
  const queries = [];
  const uniqTargets = sample(rng, uniqQueries, Math.min(150, Math.floor(200 * scale)));
  uniqTargets.forEach((u, i) => {
    queries.push(
      Q({
        qid: `q_s9_${pad(i + 1, 4)}`,
        suite: "S9_longtail",
        query: `里程碑 ${u.milestone} 的门槛是多少`,
        scope: "project",
        project: u.p.id,
        gold_ids: [u.id],
        kinds: ["unique-token"],
      }),
    );
  });
  topicalRecords.forEach((t, i) => {
    queries.push(
      Q({
        qid: `q_s9_${pad(151 + i, 4)}`,
        suite: "S9_longtail",
        query: `${t.c.zh} 的记录`,
        scope: "project",
        project: t.p.id,
        gold_ids: [t.id],
        kinds: ["topical"],
      }),
    );
  });
  return { memories, queries, pinnedIds: memories.slice(0, pinned).map((m) => m.id) };
}

// ------------------------------------------------ mirror of core dedupe math
// Byte-compatible with packages/core/src/{util,text,lifecycle}.ts (pure JS,
// no core import). The generator uses it to *assert* the write-time action
// each S10 variant must trigger; runner then measures the real engine action.
// If core changes a threshold, `--check` regeneration fails loudly here.
const S10_STOP = new Set([
  "的", "了", "是", "在", "和", "中", "我", "你", "他", "她", "好",
  "the", "a", "an", "of", "to", "is", "are", "and", "or", "in", "on", "for", "with", "this", "that",
]);
const S10_TOKEN_RE = /[\u4e00-\u9fff]+|[A-Za-z0-9_]+/g;
const S10_CJK_RE = /[\u4e00-\u9fff]/;
function normCompare(text) {
  return text.normalize("NFKC").toLowerCase().replace(/[*_`#>~-]+/g, " ").replace(/\s+/g, " ").trim();
}
function cjkGrams(text, n = 3) {
  const s = normCompare(text).replace(/\s+/g, " ");
  const out = new Set();
  if (s.length <= n) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}
function setJaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;
function fnv1a64(text) {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}
/** Mirrors core tokenize(text, {stopwords:true}). */
function coreTokenize(text) {
  if (!text) return [];
  const out = [];
  const input = text.replace(/\r\n?/g, "\n").normalize("NFKC");
  let m;
  while ((m = S10_TOKEN_RE.exec(input))) {
    const t = m[0];
    if (S10_CJK_RE.test(t)) {
      if (t.length === 1) {
        if (!S10_STOP.has(t)) out.push(t);
        continue;
      }
      for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
      out.push(t[0], t[t.length - 1]);
    } else {
      const lower = t.toLowerCase();
      if (S10_STOP.has(lower)) continue;
      if (lower.length >= 2 || /^\d+$/.test(lower)) out.push(lower);
    }
  }
  return out;
}
function coreSimhash(input) {
  const weights = new Map();
  const add = (text, factor) => {
    for (const tok of coreTokenize(text)) weights.set(tok, (weights.get(tok) ?? 0) + factor);
  };
  add(input.title, 3);
  add(input.description ?? "", 2);
  add(input.content ?? "", 1);
  const bits = new Array(64).fill(0);
  for (const [token, weight] of weights) {
    let h = fnv1a64(token);
    for (let i = 0; i < 64; i++) {
      bits[i] = (bits[i] ?? 0) + (Number(h & 1n) ? weight : -weight);
      h >>= 1n;
    }
  }
  let out = 0n;
  for (let i = 63; i >= 0; i--) out = (out << 1n) | ((bits[i] ?? 0) > 0 ? 1n : 0n);
  return out;
}
function coreHamming(a, b) {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
function coreValues(text) {
  const out = new Set();
  for (const m of text.match(/\b\d+(?:\.\d+){0,3}\b/g) ?? []) out.add(m);
  for (const m of text.match(/\d{4}-\d{2}-\d{2}/g) ?? []) out.add(m);
  return out;
}
function coreConflicts(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  for (const v of a) if (b.has(v)) return false;
  return true;
}
function tagOverlap(a = [], b = []) {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  return a.filter((t) => sb.has(t)).length / Math.min(a.length, b.length);
}
function coreSig(input) {
  const full = `${input.title} ${input.description ?? ""} ${input.content ?? ""}`;
  return {
    id: input.id ?? null,
    type: input.type ?? "project",
    scope: input.scope ?? "project",
    project: input.project ?? null,
    tags: input.tags ?? [],
    title: input.title,
    description: input.description ?? "",
    content: input.content ?? "",
    hash: normCompare(`${input.title}\n${input.description ?? ""}\n${input.content ?? ""}`),
    simhash: coreSimhash(input),
    grams: cjkGrams(full),
    titleGrams: cjkGrams(normCompare(input.title)),
    values: coreValues(full),
  };
}
/** Mirrors lifecycle.decideDedupe() for one candidate. */
function coreVerdictFromSig(canon, inc) {
  const hamming = coreHamming(canon.simhash, inc.simhash);
  const sim = setJaccard(canon.grams, inc.grams);
  if (canon.hash === inc.hash) return { action: "SKIP", sim: 1, hamming };
  if (hamming <= 3 && sim >= 0.82) return { action: "MERGE", sim, hamming };
  const titleSim = setJaccard(canon.titleGrams, inc.titleGrams);
  const contradictory = coreConflicts(canon.values, inc.values);
  if (titleSim >= 0.85 && contradictory) return { action: "SUPERSEDE", sim, hamming, titleSim };
  if (hamming <= 8 && sim >= 0.6) {
    if (contradictory && (titleSim >= 0.4 || tagOverlap(canon.tags, inc.tags) >= 0.5)) {
      return { action: "SUPERSEDE", sim, hamming, titleSim };
    }
    return { action: "LINK", sim, hamming, titleSim };
  }
  return { action: "NEW", sim, hamming, titleSim };
}
/**
 * S10 consolidation: intended *write-time action* semantics.
 * 100 groups: 20 exact-dup (SKIP), 20 near-dup (MERGE), 20 value change
 * (SUPERSEDE), 20 related-but-distinct (LINK), 20 unrelated control (NEW).
 * Canonical records are imported; each variant is written through eng.write()
 * by the runner, whose returned action is compared with the expected action.
 */
function genS10() {
  const rng = makeRng(SEED, "S10_consolidate");
  const memories = [];
  const labels = [];
  const queries = [];
  const groups = [];
  const concepts = shuffle(rng, BIL).slice(0, 100);
  const NOVEL = [
    "汤加海底火山观测站", "南极冰盖钻探进度", "撒哈拉沙尘输送模型", "横断山脉菌类调查",
    "北冰洋浮标阵列", "亚马逊冠层碳通量", "地中海底流监测", "格陵兰融水通道",
    "东非裂谷微震序列", "太平洋垃圾带组分", "喀斯特溶洞湿度", "高原冻土退化速率",
    "深海热液喷口菌群", "红树林沉积速率", "珊瑚礁白化频次", "内陆盐湖卤水",
    "极轨卫星轨道衰减", "西风带急流位置", "潮间带生物量", "冻雨微物理实验",
  ];
  const kinds = [
    ...Array(20).fill("exact"),
    ...Array(20).fill("near"),
    ...Array(20).fill("supersede"),
    ...Array(20).fill("link"),
    ...Array(20).fill("new"),
  ];
  const expectOf = { exact: "SKIP", near: "MERGE", supersede: "SUPERSEDE", link: "LINK", new: "NEW" };
  // Per-group topic words keep canonical records pairwise distinct: the shared
  // template alone would otherwise make two concepts look like duplicates.
  const topicWords = shuffle(rng, [...new Set(DOMAINS.flatMap((d) => lexZh[d]))]);
  const wordAt = (i) => topicWords[i % topicWords.length];
  const canonById = new Map();
  for (let g = 0; g < 100; g++) {
    const kind = kinds[g];
    const c = concepts[g];
    const v = NUMS[(g * 7 + 3) % NUMS.length];
    const w1 = wordAt(g * 3);
    const w2 = wordAt(g * 3 + 1);
    const created = createdDaysAgo(100 + g);
    const base = { type: "reference", category: "fact", scope: "user", project: null, importance: 6, created, updated: created };
    const tags = [c.zh, "口径"];
    const entities = [c.zh, c.en];
    const canonTitle = `${c.zh}: ${v}`;
    const canonDesc = `${c.zh} 决定采用 ${v}，已由负责人签字确认；涉及 ${w1}。`;
    const canonBody = `## 口径\n\n- ${c.zh} = ${v}\n- 备注：${c.en} 相关配置\n- 关联：${w1} / ${w2}\n`;
    const canonical = M({
      ...base,
      id: `m_s10_c${pad(g + 1, 3)}`,
      title: canonTitle,
      description: canonDesc,
      content: canonBody,
      tags,
      entities,
    });
    memories.push(canonical);
    canonById.set(canonical.id, canonical);
    groups.push({ kind, g, c, v, canonical, expect: expectOf[kind] });
  }

  const canonSigs = memories.map((m) => coreSig(m));
  const ownSig = new Map(memories.map((m, i) => [m.id, canonSigs[i]]));
  const pickVariant = (g, candidates) => {
    const group = groups[g];
    const diag = [];
    for (const cand of candidates) {
      const inc = coreSig(cand);
      const hits = [];
      for (const cs of canonSigs) {
        const vd = coreVerdictFromSig(cs, inc);
        if (vd.action === "SKIP" || vd.action === "MERGE" || vd.action === "SUPERSEDE") hits.push({ id: cs.id, ...vd });
        else if (vd.action === "LINK") hits.push({ id: cs.id, ...vd });
      }
      const strong = hits.find((h) => h.action !== "LINK");
      let action = "NEW";
      let matched = null;
      let info = { sim: 0, hamming: 0, titleSim: 0 };
      if (strong) {
        action = strong.action;
        matched = strong.id;
        info = { sim: strong.sim, hamming: strong.hamming, titleSim: strong.titleSim ?? 0 };
      } else if (hits.length) {
        action = "LINK";
        matched = hits[0].id;
        info = { sim: hits[0].sim, hamming: hits[0].hamming, titleSim: hits[0].titleSim ?? 0 };
      }
      diag.push({
        action,
        matched,
        sim: Math.round(info.sim * 1000) / 1000,
        hamming: info.hamming,
        nHits: hits.length,
        ownCand: (() => {
          const cs = canonSigs.find((s) => s.id === group.canonical.id);
          if (!cs) return "missing";
          const vd = coreVerdictFromSig(cs, inc);
          return `${vd.action}:${Math.round(vd.sim * 1000) / 1000}/${vd.hamming}`;
        })(),
        firstHits: hits.slice(0, 3).map((h) => `${h.id}:${h.action}:${Math.round(h.sim * 1000) / 1000}/${h.hamming}`),
      });
      if (action !== group.expect) continue;
      if (group.expect === "NEW") {
        if (matched !== null) continue;
      } else if (matched !== group.canonical.id) {
        continue;
      }
      return { input: cand, info };
    }
    throw new Error(`[gen:S10] group ${g} (${group.kind}) found no variant with expected action ${group.expect}; diag=${JSON.stringify(diag)}`);
  };

  for (let g = 0; g < 100; g++) {
    const group = groups[g];
    const { c, v } = group;
    const w1 = wordAt(group.g * 3);
    const w2 = wordAt(group.g * 3 + 1);
    const tags = [c.zh, "口径"];
    const entities = [c.zh, c.en];
    const mk = (title, description, content) => ({ type: "reference", category: "fact", scope: "user", project: null, title, description, content, tags, entities, importance: 5, confidence: 0.9, pinned: false });
    let candidates;
    let extra = {};
    if (group.kind === "exact") {
      candidates = [
        mk(group.canonical.title, group.canonical.description, group.canonical.content),
      ];
    } else if (group.kind === "near") {
      // Near-duplicate must stay *mergeable*: tokenizer-invisible punctuation
      // edits keep simhash distance <=3 while changing the content hash.
      const altDesc = group.canonical.description.replace("；已由", "。已由").replace("；涉及", "，涉及");
      candidates = [
        mk(group.canonical.title, altDesc, group.canonical.content),
        mk(`${c.zh}：${v}`, group.canonical.description, group.canonical.content),
        mk(group.canonical.title, group.canonical.description, group.canonical.content.replace("## 口径", "## 口径：")),
      ];
    } else if (group.kind === "supersede") {
      const v2 = NUMS[(g * 7 + 3 + 5) % NUMS.length];
      if (v2 === v) throw new Error(`[gen:S10] supersede group ${g} reused value`);
      extra = { query_old: `${c.zh} 采用 ${v}`, query_new: `${c.zh} 口径调整为 ${v2}`, old_value: String(v), new_value: String(v2) };
      // Stay lexically close to the old record (sim in the 0.6-0.82 band, i.e.
      // *not* a merge) but flip the value -> lifecycle must SUPERSEDE.
      candidates = [
        mk(`${c.zh}: ${v2}`, `${c.zh} 决定采用 ${v2}，已由负责人签字确认；涉及 ${w1}。作废。`, `## 口径\n\n- ${c.zh} = ${v2}\n- 备注：${c.en} 相关配置\n- 关联：${w1} / ${w2}\n`),
        mk(`${c.zh}: ${v2}`, `${c.zh} 决定采用 ${v2}，已由负责人签字确认；涉及 ${w1}。`, `## 口径\n\n- ${c.zh} = ${v2}\n- 备注：${c.en} 相关配置\n- 停用\n`),
        mk(`${c.zh}: ${v2}`, `${c.zh} 决定采用 ${v2}，已由负责人签字确认；涉及 ${w1}。`, `## 口径\n\n- ${c.zh} = ${v2}\n- 关联：${w1} / ${w2}\n`),
      ];
    } else if (group.kind === "link") {
      const altDesc = group.canonical.description.replace("；已由", "。已由");
      const descTails = ["", "已评审。", "评审已归档。"];
      const bodyExtras = [
        "- 评审\n",
        "- 评审通过\n",
        "- 评审通过并归档\n",
        "- 评审记录与结论已归档\n",
        "## 备注\n\n- 例会评审\n",
        "## 备注\n\n- 评审结论：通过\n",
        "## 备注\n\n- 评审与归档均已完成\n",
      ];
      candidates = [];
      for (const tail of descTails) {
        for (const extra of bodyExtras) {
          candidates.push(mk(`${c.zh}：${v}`, `${altDesc}${tail}`, `${group.canonical.content}${extra}`));
        }
      }
    } else {
      const novel = NOVEL[(g - 80) % NOVEL.length];
      candidates = [
        mk(`${novel} 观测记录`, `${novel} 的例行观测数据与现场记录。`, `## 观测\n\n- ${novel} 数据已归档\n- 备注：常规巡检\n`),
        { ...mk(`${novel} 巡检摘要`, `${novel} 的巡检结论与后续安排。`, `## 巡检\n\n- ${novel} 状态正常\n- 下次巡检：下月\n`), tags: ["观测"], entities: [] },
      ];
      extra = { novel };
    }
    const picked = pickVariant(g, candidates);
    labels.push({
      group: g,
      kind: group.kind,
      expect_action: group.expect,
      canonical_id: group.canonical.id,
      own_sim: Math.round(picked.info.sim * 1000) / 1000,
      own_hamming: picked.info.hamming,
      own_title_sim: Math.round((picked.info.titleSim ?? 0) * 1000) / 1000,
      ...extra,
      input: picked.input,
    });
  }

  // Retrieval queries: stable groups must stay retrievable after consolidation.
  const stable = groups.filter((x) => x.kind === "exact" || x.kind === "near" || x.kind === "link");
  sample(rng, stable, 30).forEach((group, i) => {
    queries.push(
      Q({
        qid: `q_s10_${pad(i + 1, 4)}`,
        suite: "S10_consolidate",
        query: `${group.c.zh} 是什么口径`,
        scope: "user",
        gold_ids: [group.canonical.id],
        kinds: ["consolidate"],
      }),
    );
  });
  // History queries: the superseded value stays reachable via include_history
  // only; the default (active-only) search must not leak it.
  groups.forEach((group, i) => {
    if (group.kind !== "supersede") return;
    queries.push(
      Q({
        qid: `q_s10_h_${pad(i + 1, 4)}`,
        suite: "S10_consolidate",
        query: `${group.c.zh} 采用 ${group.v}`,
        scope: "user",
        gold_ids: [group.canonical.id],
        include_history: true,
        kinds: ["history"],
      }),
    );
  });
  return { memories, queries, labels };
}

// S11 noisy text: typos, truncation, overlong bodies.
function genS11() {
  const rng = makeRng(SEED, "S11_noisy_text");
  const memories = [];
  const queries = [];
  const concepts = shuffle(rng, BIL).slice(0, 60);
  const swapChar = (s) => {
    const i = ri(rng, Math.max(1, s.length - 1));
    const a = s[i];
    const b = s[i + 1] ?? a;
    return s.slice(0, i) + b + a + s.slice(i + 2);
  };
  const longBody = (c) => {
    const parts = [];
    for (let k = 0; k < 40; k++) parts.push(`- 第 ${k} 段：${c.zh} 与 ${pick(rng, lexZh.coding)} 的例行说明，供检索用。`);
    return `## ${c.zh}\n\n${parts.join("\n")}\n`;
  };
  let n = 0;
  for (let i = 0; i < 70; i++) {
    const c = concepts[i % concepts.length];
    n++;
    const created = createdDaysAgo(20 + i);
    memories.push(
      M({
        id: `m_s11_${pad(n)}`,
        type: "project",
        category: "lesson",
        scope: "project",
        project: "proj-alpha",
        title: swapChar(`${c.zh} 记录`),
        description: swapChar(`${c.zh} 的注意事项，${pick(rng, lexZh.coding)} 场景适用。`),
        content: `## ${c.zh}\n\n- 含错别字的记录\n`,
        tags: [c.zh],
        importance: 5,
        created,
        updated: created,
      }),
    );
  }
  for (let i = 0; i < 60; i++) {
    const c = concepts[(i * 3) % concepts.length];
    n++;
    const created = createdDaysAgo(30 + i);
    const full = `${c.zh} 的完整描述：在 ${pick(rng, lexZh.project)} 场景下按 ${pick(rng, NUMS)} 执行。`;
    memories.push(
      M({
        id: `m_s11_${pad(n)}`,
        type: "project",
        category: "convention",
        scope: "project",
        project: "proj-alpha",
        title: `${c.zh} 约定`,
        description: full.slice(0, Math.floor(full.length * 0.45)),
        content: `## ${c.zh}\n\n- 截断描述\n`,
        tags: [c.zh],
        importance: 5,
        created,
        updated: created,
      }),
    );
  }
  for (let i = 0; i < 70; i++) {
    const c = concepts[(i * 7) % concepts.length];
    n++;
    const created = createdDaysAgo(40 + i);
    memories.push(
      M({
        id: `m_s11_${pad(n)}`,
        type: "project",
        category: "reference",
        scope: "project",
        project: "proj-alpha",
        title: `${c.zh} 长文记录`,
        description: `${c.zh} 的超长正文记录（>2k 字）。`,
        content: longBody(c),
        tags: [c.zh],
        importance: 5,
        created,
        updated: created,
      }),
    );
  }
  const targets = sample(rng, memories, 30);
  targets.forEach((mem, i) => {
    const c = mem.tags[0] ?? "记录";
    queries.push(
      Q({
        qid: `q_s11_${pad(i + 1, 4)}`,
        suite: "S11_noisy_text",
        query: `${c} 的记录是什么`,
        scope: "project",
        project: "proj-alpha",
        gold_ids: [mem.id],
        kinds: ["noisy"],
      }),
    );
  });
  return { memories, queries };
}

// ---------------------------------------------------------------- writer
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
function writeSuite(name, payload, outDir) {
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    suite: name,
    generatorVersion: GEN_VERSION,
    seed: SEED,
    lexiconHash: dataHash,
    now: NOW,
    kind: payload.kind ?? "retrieval",
    counts: {
      memories: payload.memories?.length ?? 0,
      queries: payload.queries?.length ?? 0,
      labels: payload.labels?.length ?? 0,
    },
    ...(payload.pool ? { pool: payload.pool } : {}),
    ...(payload.pinnedIds ? { pinnedIds: payload.pinnedIds } : {}),
    ...(payload.repeats ? { repeats: payload.repeats } : {}),
  };
  if (payload.memories) writeFileSync(join(dir, "memories.jsonl"), jsonl(sortById(payload.memories)), "utf8");
  if (payload.queries?.length) writeFileSync(join(dir, "queries.jsonl"), jsonl(payload.queries), "utf8");
  if (payload.labels?.length) writeFileSync(join(dir, "labels.jsonl"), jsonl(payload.labels), "utf8");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}
const sortById = (rows) => rows.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

function buildAll(scale) {
  const s1 = genS1();
  const s2 = genS2();
  const s3 = genS3();
  const s4 = genS4();
  const s5 = genS5();
  const s6 = genS6();
  const s7 = genS7();
  const s8 = genS8();
  const s9 = genS9(scale);
  const s10 = genS10();
  const s11 = genS11();
  return {
    S1_profile: s1,
    S2_project: s2,
    S3_temporal: s3,
    S4_forget: s4,
    S5_multihop: s5,
    S6_abstain: s6,
    S7_distractor: s7,
    S8_bilingual: s8,
    S9_longtail: s9,
    S10_consolidate: s10,
    S11_noisy_text: s11,
    S12_budget: { kind: "context", pool: "S9_longtail", repeats: 50, pinnedIds: s9.pinnedIds, memories: undefined, queries: undefined },
  };
}

function main(argv) {
  const args = argv.slice(2);
  const check = args.includes("--check");
  const outDir = join(EVALS, check ? ".check" : "corpora");
  let scale = 1;
  const si = args.indexOf("--scale");
  if (si >= 0) scale = Number(args[si + 1] ?? 1) || 1;
  if (check && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const all = buildAll(scale);
  const manifests = {};
  for (const [name, payload] of Object.entries(all)) manifests[name] = writeSuite(name, payload, outDir);
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify({ seed: SEED, generatorVersion: GEN_VERSION, lexiconHash: dataHash, now: NOW, scale, suites: manifests }, null, 2) + "\n",
    "utf8",
  );
  const totalM = Object.values(manifests).reduce((a, m) => a + m.counts.memories, 0);
  const totalQ = Object.values(manifests).reduce((a, m) => a + m.counts.queries, 0);
  console.log(`[gen] seed=${SEED} scale=${scale} suites=12 memories=${totalM} queries=${totalQ} -> ${outDir}`);
  for (const [name, m] of Object.entries(manifests)) {
    console.log(`  ${name.padEnd(16)} mem=${String(m.counts.memories).padStart(5)} q=${String(m.counts.queries).padStart(4)} labels=${m.counts.labels}`);
  }
  if (check) {
    const ref = join(EVALS, "corpora");
    const diffs = [];
    const walk = (dir, base = "") => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const rel = base ? `${base}/${name}` : name;
        if (statSync(full).isDirectory()) walk(full, rel);
        else diffs.push(rel);
      }
    };
    if (!existsSync(ref)) {
      console.error("[gen:check] no committed corpora/ to compare against");
      process.exit(2);
    }
    walk(outDir);
    const bad = [];
    for (const rel of diffs) {
      const a = join(ref, rel);
      const b = join(outDir, rel);
      if (!existsSync(a)) bad.push(`missing in corpora/: ${rel}`);
      else if (!readFileSync(a).equals(readFileSync(b))) bad.push(`bytes differ: ${rel}`);
    }
    if (bad.length) {
      console.error(`[gen:check] FAIL (${bad.length})`);
      for (const x of bad.slice(0, 20)) console.error("  " + x);
      process.exit(1);
    }
    console.log(`[gen:check] OK: ${diffs.length} files byte-identical (seed=${SEED}, lexicon=${dataHash.slice(0, 12)})`);
    rmSync(outDir, { recursive: true, force: true });
    process.exit(0);
  }
}
main(process.argv);
