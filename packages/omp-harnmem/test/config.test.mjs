/**
 * Config regression tests for the omp adapter: `~` expansion in HARNMEM_HOME
 * and config-file "home" values (a literal `~` used to become a wrong store
 * directory).
 *
 * Reading the real user `~/.harnmem/config.json` here is safe: the fixture
 * project `.harnmem.json` is merged last, so its `home` always wins the
 * assertion, and nothing is ever written outside the temp dir.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { resolveSettings } from "../dist/config.js";

const CWD = process.cwd();
const HOME = homedir();

test("env home supports a literal ~ and ~-prefixed paths", () => {
  assert.equal(resolveSettings(CWD, { HARNMEM_HOME: "~" }).home, HOME);
  assert.equal(resolveSettings(CWD, { HARNMEM_HOME: "~/.harnmem-test" }).home, join(HOME, ".harnmem-test"));
});

test("plain env home resolves against cwd", () => {
  assert.equal(resolveSettings(CWD, { HARNMEM_HOME: "rel-store" }).home, resolve(CWD, "rel-store"));
});

test("config-file home supports ~ expansion; env wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harnmem-omp-settings-"));
  const project = join(dir, "project");
  try {
    await mkdir(project, { recursive: true });
    await writeFile(join(project, ".harnmem.json"), JSON.stringify({ home: "~/fixture-store" }), "utf8");

    const fromConfig = resolveSettings(project, {});
    assert.equal(fromConfig.home, join(HOME, "fixture-store"));

    const envWins = resolveSettings(project, { HARNMEM_HOME: join(dir, "env-store") });
    assert.equal(envWins.home, resolve(join(dir, "env-store")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
