#!/usr/bin/env node
/**
 * Vendoring step: copy @harnmem/core's built dist into vendor/core so the
 * installed plugin directory is self-contained (the installer copies
 * packages/cursor-harnmem into ~/.cursor/plugins/local/harnmem, where
 * workspace: deps cannot be resolved).
 *
 * Run automatically via `pnpm build` in this package. Zero-copy import map:
 * adapter code imports "../vendor/core/index.js" (see lib/engine.mjs).
 */

import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");
const src = path.join(pkgRoot, "..", "core", "dist");
const dest = path.join(pkgRoot, "vendor", "core");

try {
  await stat(src);
} catch {
  console.error(`[vendor] @harnmem/core dist not found at ${src}; run \`pnpm --filter @harnmem/core build\` first.`);
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await mkdir(path.dirname(dest), { recursive: true });
await cp(src, dest, { recursive: true });

// Ship the editable asset defaults too: core's findAssetRoot() walks up from
// vendor/core looking for prompts/extract.md — copying them INTO vendor/core
// makes a vendored install discover its own shipped prompts/synonym tables
// (findAssetRoot checks the module directory first). Without them an
// npm-installed plugin silently degrades to the inline fallbacks (shorter
// extraction prompt, 6 builtin synonym groups -> worse zh/en recall).
let assets = 0;
for (const rel of ["prompts", "data"]) {
  const from = path.join(pkgRoot, "..", "..", rel);
  try {
    await stat(from);
  } catch {
    console.warn(`[vendor] optional asset dir not found, skipped: ${path.relative(pkgRoot, from)}`);
    continue;
  }
  await cp(from, path.join(dest, rel), { recursive: true });
  assets += 1;
}

console.log(`[vendor] copied @harnmem/core dist -> ${path.relative(pkgRoot, dest)} (+${assets} asset dir(s))`);
