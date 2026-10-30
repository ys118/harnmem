/**
 * Vendored install self-containment: core's findAssetRoot() looks for
 * prompts/extract.md and data/synonyms.*.txt starting at the module directory.
 * The vendored copy must ship them, or an npm-installed plugin silently
 * degrades (shorter extraction prompt, 6 builtin synonym groups -> worse
 * zh/en recall). Mirrors packages/opencode-harnmem/test coverage.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendored = path.join(pkgRoot, "vendor", "core");

test("vendored core ships prompts and synonym data", () => {
  assert.ok(existsSync(path.join(vendored, "prompts", "extract.md")), "vendor/core/prompts/extract.md missing");
  assert.ok(existsSync(path.join(vendored, "data", "synonyms.en.txt")), "vendor/core/data/synonyms.en.txt missing");
  assert.ok(existsSync(path.join(vendored, "data", "synonyms.zh.txt")), "vendor/core/data/synonyms.zh.txt missing");
});
