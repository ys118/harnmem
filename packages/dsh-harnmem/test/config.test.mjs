/**
 * Config regression tests for the dsh adapter: `~` expansion + cwd resolution
 * of the store root (a literal `~/.harnmem` used to stay an unresolved string).
 */

import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { resolveSettings } from "../dist/config.js";

const CWD = process.cwd();
const HOME = homedir();

test("store root defaults to ~/.harnmem", () => {
  assert.equal(resolveSettings({}, {}).home, join(HOME, ".harnmem"));
});

test("env home supports a literal ~ and ~-prefixed paths", () => {
  assert.equal(resolveSettings({}, { HARNMEM_HOME: "~" }).home, HOME);
  assert.equal(resolveSettings({}, { HARNMEM_HOME: "~/.harnmem-test" }).home, join(HOME, ".harnmem-test"));
});

test("plain env home resolves against cwd; env wins over config", () => {
  assert.equal(resolveSettings({}, { HARNMEM_HOME: "rel-store" }).home, resolve(CWD, "rel-store"));
  assert.equal(resolveSettings({ home: "~/from-config" }, {}).home, join(HOME, "from-config"));
  assert.equal(resolveSettings({ home: "~/from-config" }, { HARNMEM_HOME: join(tmpdir(), "dsh-store") }).home, resolve(join(tmpdir(), "dsh-store")));
});
