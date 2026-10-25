/**
 * Synonym suggestions: harvest, prompt building, validation, offline and LLM runs.
 * The shipped prompt asset is exercised too, so a broken prompts/synonyms.md
 * shows up here instead of at runtime.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildSuggestPrompt,
  cleanTerm,
  deployDefaultAssets,
  harvestTerms,
  parseSuggestionGroups,
  suggestFromResponse,
  suggestSynonyms,
  validateSuggestions,
} from "../dist/index.js";

async function tempHome() {
  const home = await mkdtemp(join(tmpdir(), "harnmem-suggest-test-"));
  deployDefaultAssets(home);
  return home;
}

const RECORDS = [
  {
    title: "涨停板策略复盘",
    description: "首板封单不足时放弃，次日溢价观察",
    tags: ["涨停板", "复盘"],
    entities: ["涨停板"],
  },
  {
    title: "部署流程",
    description: "用 pnpm 构建后发布到服务器，回滚用上一版本",
    tags: ["部署", "发布"],
  },
];

test("cleanTerm trims model punctuation without touching the term", () => {
  assert.equal(cleanTerm('  "打板"  '), "打板");
  assert.equal(cleanTerm("（涨停板），"), "涨停板");
  assert.equal(cleanTerm(" -rollback. "), "rollback");
});

test("harvestTerms weights tags and entities above body text and honours minSupport", () => {
  const terms = harvestTerms(RECORDS, [], { minSupport: 1 });
  const byTerm = new Map(terms.map((term) => [term.term, term]));
  const tagged = byTerm.get("涨停板");
  assert.ok(tagged, "a tag term is harvested");
  assert.equal(tagged.support, 1, "support counts records, not source fields");
  assert.ok(tagged.score > 2, "a tag term scores above plain body text");

  const strict = harvestTerms(RECORDS, [], { minSupport: 2 });
  assert.ok(!strict.some((term) => term.term === "复盘"), "a term seen once is filtered at minSupport 2");
});

test("harvestTerms drops function words and normalises ASCII", () => {
  const terms = harvestTerms([{ title: "Deploy THE Rollback", description: "需要 进行 部署 the" }], [], { minSupport: 1 });
  const harvested = terms.map((term) => term.term);
  assert.ok(harvested.includes("deploy"), "ASCII is lowercased");
  assert.ok(!harvested.includes("the"), "English stop words are dropped");
  assert.ok(!harvested.includes("进行"), "Chinese function words are dropped");
});

test("buildSuggestPrompt uses the shipped asset and fills every placeholder", async () => {
  const home = await tempHome();
  const prompt = buildSuggestPrompt(home, { records: RECORDS, language: "zh" });
  assert.ok(prompt.source.replaceAll("\\", "/").endsWith("prompts/synonyms.md"), `unexpected source ${prompt.source}`);
  assert.ok(prompt.hasTemplate, "the asset carries a user section");
  assert.ok(prompt.system.startsWith("You maintain the synonym table"), "system section comes from the asset");
  assert.ok(prompt.system.includes("降级"), "the shipped rules keep their examples");
  assert.ok(prompt.user.includes("Language: zh"));
  assert.ok(prompt.user.includes("涨停板"), "harvested terms are listed");
  assert.ok(prompt.user.includes("部署 = "), "existing shipped groups are listed");
  assert.ok(prompt.user.includes("Sample memories:"));
  assert.ok(!prompt.user.includes("{{"), "no placeholder is left unfilled");
});

test("buildSuggestPrompt relaxes the support threshold for a tiny corpus", async () => {
  const home = await tempHome();
  const prompt = buildSuggestPrompt(home, { records: [RECORDS[0]] });
  assert.ok(prompt.terms.length > 0, "a single record still yields candidate terms");
  assert.ok(!prompt.user.includes("(none)"), "the terms block is not empty");
});

test("parseSuggestionGroups tolerates fences and prose", () => {
  const raw = 'Here you go:\n```json\n{"groups":[{"canonical":"打板","synonyms":["涨停板"]}]}\n```\n';
  const parsed = parseSuggestionGroups(raw);
  assert.equal(parsed.groups.length, 1);
  assert.deepEqual(parsed.groups[0], { canonical: "打板", synonyms: ["涨停板"] });
  assert.equal(parseSuggestionGroups("no json here").groups.length, 0);
});

test("validateSuggestions accepts a usable group and explains every rejection", () => {
  const corpus = "涨停板策略复盘 首板封单不足 部署流程 用 pnpm 构建后发布";
  const existing = [["部署", "发布"]];
  const { proposals, rejected } = validateSuggestions(
    [
      { canonical: "涨停板", synonyms: ["打板"] },
      { canonical: "不存在的词", synonyms: ["foo"] },
      { canonical: "部署", synonyms: ["上线"] },
      { canonical: "涨停板策略", synonyms: ["涨停板"] },
      { canonical: "我们", synonyms: ["大家"] },
      { canonical: "涨停板", synonyms: ["炸板"] },
    ],
    { corpus, existing, terms: [] },
  );
  assert.deepEqual(proposals, [{ canonical: "涨停板", synonyms: ["打板"] }]);
  const reasons = rejected.map((rejection) => rejection.reason);
  assert.ok(reasons.includes("canonical does not occur in the corpus"));
  assert.ok(reasons.includes("canonical is already in the tables in force"));
  assert.ok(reasons.some((reason) => reason.includes("substring")), reasons.join(" | "));
  assert.ok(reasons.includes("canonical is a function word"));
  assert.ok(reasons.includes("duplicate canonical in the model output"));
});

test("suggestFromResponse validates an offline model answer", async () => {
  const home = await tempHome();
  const response = JSON.stringify({
    groups: [
      { canonical: "涨停板", synonyms: ["打板"] },
      { canonical: "不存在的词", synonyms: ["foo"] },
      { canonical: "部署", synonyms: ["上线"] },
    ],
  });
  const result = suggestFromResponse(home, { records: RECORDS }, response);
  assert.deepEqual(
    result.proposals.map((proposal) => proposal.canonical),
    ["涨停板"],
  );
  assert.equal(result.parsedGroups, 3);
  assert.equal(result.rejected.length, 2);
  assert.ok(result.prompt.user.includes("涨停板策略复盘"));
});

test("suggestSynonyms sends one stable prompt and returns validated groups", async () => {
  const home = await tempHome();
  let seen = null;
  const llm = async (request) => {
    seen = request;
    return { text: '{"groups":[{"canonical":"涨停板","synonyms":["打板","封单"]}]}' };
  };
  const result = await suggestSynonyms(home, { records: RECORDS, llm });
  assert.ok(seen, "the bridge was called once");
  assert.equal(seen.maxTokens, 1500);
  assert.equal(seen.temperature, 0);
  assert.ok(seen.system.startsWith("You maintain the synonym table"));
  assert.ok(seen.prompt.includes("Sample memories:"));
  assert.deepEqual(result.proposals, [{ canonical: "涨停板", synonyms: ["打板", "封单"] }]);
  assert.equal(result.parsedGroups, 1);
});

test("an empty corpus is a clear error, not an empty prompt", async () => {
  const home = await tempHome();
  await assert.rejects(
    async () => suggestFromResponse(home, { records: [] }, "{}"),
    /needs a corpus/,
  );
  await assert.rejects(
    () => suggestSynonyms(home, { records: [], llm: async () => ({ text: "{}" }) }),
    /needs a corpus/,
  );
});
