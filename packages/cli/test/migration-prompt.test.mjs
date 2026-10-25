/**
 * The shipped agent-facing migration recipe: present in the repo, well-formed,
 * and deployed into a fresh HarnMem home like the other prompt assets.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { isolatedStores, runCli, shippedPrompt } from "./helpers.mjs";

test("prompts/migrate.md is a complete recipe with the documented placeholders", async () => {
  const file = shippedPrompt("migrate.md");
  assert.ok(existsSync(file), `missing ${file}`);
  const raw = await readFile(file, "utf8");
  assert.match(raw, /^## system$/m);
  assert.match(raw, /^## user$/m);
  for (const placeholder of ["{{source}}", "{{target_home}}", "{{harnmem}}"]) {
    assert.ok(raw.includes(placeholder), `missing ${placeholder}`);
  }
  assert.match(raw, /import json --path/);
  assert.match(raw, /--apply --verify/);
  assert.match(raw, /never invent/i);
});

test("the recipe is deployed into <home>/prompts by the first engine open", async () => {
  const stores = await isolatedStores("prompt-asset");
  const run = await runCli(["stats", "--home", stores.home], { env: stores.env });
  assert.equal(run.code, 0, run.stderr);
  const deployed = join(stores.home, "prompts", "migrate.md");
  assert.ok(existsSync(deployed), `expected ${deployed} after opening the store`);
  assert.match(await readFile(deployed, "utf8"), /memory migration assistant/i);
});
