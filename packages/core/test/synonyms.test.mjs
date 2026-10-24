/**
 * Synonym table discovery: language-tagged data files, home overrides, parser.
 * Kept in a separate file from assets.test.mjs so write scopes stay disjoint.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  HarnMem,
  deployDefaultAssets,
  listSynonymFiles,
  loadSynonymGroups,
  parseSynonymTable,
} from "../dist/index.js";

async function tempHome() {
  return mkdtemp(join(tmpdir(), "harnmem-synonyms-test-"));
}

test("shipped tables deploy as language-tagged files and both load", async () => {
  const home = await tempHome();
  deployDefaultAssets(home);
  const files = listSynonymFiles(home);
  assert.ok(files.includes("synonyms.zh.txt"), `expected zh table, got ${files.join(",")}`);
  assert.ok(files.includes("synonyms.en.txt"), `expected en table, got ${files.join(",")}`);
  const { groups } = loadSynonymGroups(home);
  assert.ok(groups.some((group) => group[0] === "部署"), "Chinese rows load");
  assert.ok(groups.some((group) => group[0] === "deploy"), "English rows load");
});

test("adding a language is a data-only operation", async () => {
  const home = await tempHome();
  deployDefaultAssets(home);
  await writeFile(join(home, "data", "synonyms.fr.txt"), "deploiement\tmise en production,release\n", "utf8");
  const { groups, files } = loadSynonymGroups(home);
  assert.ok(files.includes("synonyms.fr.txt"));
  assert.ok(groups.some((group) => group[0] === "deploiement"), "unknown language file is loaded");
});

test("a home copy overrides the shipped table of the same filename", async () => {
  const home = await tempHome();
  deployDefaultAssets(home);
  await writeFile(join(home, "data", "synonyms.en.txt"), "deploy\trelease only\n", "utf8");
  const { groups } = loadSynonymGroups(home);
  assert.deepEqual(groups.find((group) => group[0] === "deploy"), ["deploy", "release only"]);
  assert.ok(!groups.some((group) => group[0] === "pull request"), "shipped en rows no longer load");
  assert.ok(groups.some((group) => group[0] === "部署"), "the other language is unaffected");
});

test("parser accepts the documented separators and skips comments", () => {
  const groups = parseSynonymTable("# comment\n部署\t上线,发布\n重构：重写、整理\nconfig: setting,选项\n\nbadline\n");
  assert.deepEqual(groups[0], ["部署", "上线", "发布"]);
  assert.deepEqual(groups[1], ["重构", "重写", "整理"]);
  assert.deepEqual(groups[2], ["config", "setting", "选项"]);
  assert.equal(groups.length, 3);
});

test("a home language file changes search expansion end to end", async () => {
  const home = await tempHome();
  const cwd = await mkdtemp(join(tmpdir(), "harnmem-synonyms-proj-"));
  deployDefaultAssets(home);
  await writeFile(join(home, "data", "synonyms.en.txt"), "zzmarker\tunicornx\n", "utf8");
  const eng = await HarnMem.open({ harness: "test", home, cwd });
  await eng
    .write({
      type: "project",
      scope: "project",
      title: "unicornx rollout notes",
      description: "unicornx is the internal build agent.",
      content: "unicornx is the internal build agent.",
    })
    .catch(() => undefined);
  const hit = await eng.search({ query: "zzmarker", debug: true });
  const control = await eng.search({ query: "qqmarker", debug: true });
  await eng.close();
  assert.equal(hit.debug?.candidateCount, 1, "query should be expanded through the home synonym file");
  assert.equal(control.debug?.candidateCount, 0, "an unmapped term must not discover the candidate");
});

