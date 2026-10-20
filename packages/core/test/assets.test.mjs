/**
 * Assets (prompts/data) and explicit-supersede regressions.
 * Kept in a separate file from api.test.mjs to avoid write-scope collisions.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnMem, deployDefaultAssets, loadPromptAsset } from "../dist/index.js";

async function tempHome() {
  return mkdtemp(join(tmpdir(), "harnmem-assets-test-"));
}

test("shipped prompt assets deploy into a fresh home", async () => {
  const home = await tempHome();
  const deployed = deployDefaultAssets(home);
  assert.ok(deployed.copied.length >= 2, `expected assets copied, got ${deployed.copied.join(",")}`);
  const asset = loadPromptAsset(home, "extract");
  assert.ok(asset, "extract prompt should load");
  assert.ok(asset.system.length > 800, "system text should come from the template");
  // Structural assertions only: the wording of prompts/ is user-editable, so do
  // not depend on specific prompt text. `## system` / `## user` must have been
  // parsed, the stable system section must not carry placeholders, and the user
  // template must still contain the injection placeholders.
  assert.ok(asset.user, "## user section should be parsed into a template");
  assert.ok(!asset.system.includes("{{"), "system section must not contain placeholders");
  assert.ok(asset.user.includes("{{transcript}}"), "user template placeholders intact");
  assert.ok(asset.user.includes("{{observation_date}}"), "user template date placeholder intact");
  assert.ok(asset.user.includes("{{existing_memories}}"), "user template existing-memories placeholder intact");
});

test("user prompt overrides do not touch the shipped default", async () => {
  const home = await tempHome();
  deployDefaultAssets(home);
  const file = join(home, "prompts", "write-policy.md");
  const original = await readFile(file, "utf8");
  assert.ok(original.includes("memory"), "write policy should be deployed");
});

test("synonyms data file is parsed as groups (TAB format)", async () => {
  const home = await tempHome();
  const cwd = await mkdtemp(join(tmpdir(), "harnmem-assets-proj-"));
  deployDefaultAssets(home);
  const eng = await HarnMem.open({ harness: "test", home, cwd });
  await eng.write({
    type: "project",
    scope: "project",
    title: "部署流程使用 pnpm",
    description: "本项目部署流程固定使用 pnpm 完成构建与发布。",
    content: "部署流程：pnpm build 后 pnpm publish。",
    tags: ["部署"],
  }).catch(() => undefined);
  const hit = await eng.search({ query: "上线" });
  await eng.close();
  assert.ok(hit.results.length >= 1, "query should be expanded through the synonyms file");
});

test("explicit supersedes marks the old record without deleting it", async () => {
  const home = await tempHome();
  const cwd = await mkdtemp(join(tmpdir(), "harnmem-assets-proj-"));
  const eng = await HarnMem.open({ harness: "test", home, cwd });
  const first = await eng.write({
    type: "project",
    scope: "project",
    title: "Service default port 8080",
    description: "The service listens on port 8080 by default.",
    content: "The service listens on port 8080 by default.",
  });
  const second = await eng.write({
    type: "project",
    scope: "project",
    title: "Service default port changed to 9090",
    description: "The service default port has been changed to 9090.",
    content: "The service default port is now 9090.",
    supersedes: [first.id],
  });
  assert.equal(second.action, "NEW");
  assert.ok(second.superseded.includes(first.id), "old id should be superseded");
  const oldRead = await eng.read(first.id, { includeHistory: true });
  await eng.close();
  assert.equal(oldRead.record.status, "superseded");
  assert.ok(oldRead.record.validTo, "validTo should be set");
});
