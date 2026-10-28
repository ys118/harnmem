#!/usr/bin/env node
/**
 * Vendoring step: copy @harnmem/core's built dist into vendor/core so the
 * installed plugin directory is self-contained (marketplace installs are a
 * git-subdir checkout of packages/claude-harnmem and cannot resolve
 * workspace: deps).
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
console.log(`[vendor] copied @harnmem/core dist -> ${path.relative(pkgRoot, dest)}`);
