#!/usr/bin/env node
/**
 * Ship the editable asset defaults with the bundled dist: core's
 * findAssetRoot() walks up from dist/index.js, so copying the repo-root
 * prompts/ and data/ INTO dist/ makes an installed plugin discover its own
 * shipped extraction prompt and synonym tables (first HarnMem.open() deploys
 * them into <home>). Without them the plugin silently degrades to core's
 * inline fallbacks (shorter extraction prompt, 6 builtin synonym groups ->
 * worse zh/en recall). See packages/opencode-harnmem/scripts/vendor.mjs for
 * the same mechanism in a vendor-dir layout.
 */

import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");
const dist = path.join(pkgRoot, "dist");

let assets = 0;
for (const rel of ["prompts", "data"]) {
  const from = path.join(pkgRoot, "..", "..", rel);
  try {
    await stat(from);
  } catch {
    console.warn(`[vendor] optional asset dir not found, skipped: ${path.relative(pkgRoot, from)}`);
    continue;
  }
  await mkdir(dist, { recursive: true });
  await cp(from, path.join(dist, rel), { recursive: true });
  assets += 1;
}

console.log(`[vendor] copied ${assets} asset dir(s) -> dist/ (prompts, data)`);
