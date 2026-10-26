#!/usr/bin/env node
/**
 * Copy the shipped prompt assets and synonym tables into `packages/core/` so
 * they end up in the `@harnmem/core` npm tarball (the engine discovers them by
 * walking up from `dist/` — see `findAssetRoot()` in `src/assets.ts`).
 *
 * The repository root stays the single source of truth; the copies are
 * generated and gitignored. This runs automatically through the `prepack`
 * script of `packages/core`, i.e. on `pnpm publish` and `pnpm pack`.
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const coreDir = join(repoRoot, "packages", "core");
const directories = ["prompts", "data"];

let failed = false;

for (const directory of directories) {
  const from = join(repoRoot, directory);
  const to = join(coreDir, directory);
  if (!existsSync(from)) {
    console.error(`sync-assets: missing source directory ${from}`);
    failed = true;
    continue;
  }
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  console.log(`sync-assets: ${directory}/ -> packages/core/${directory}/`);
}

if (failed) process.exitCode = 1;
