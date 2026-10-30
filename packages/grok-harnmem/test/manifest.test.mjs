/**
 * Plugin packaging invariants for Grok.
 *
 * Grok plugins are just files: a manifest (native `.grok-plugin/plugin.json`,
 * with the `.claude-plugin/` equivalent also accepted), `hooks/hooks.json`,
 * `.mcp.json`, `commands/`, `skills/`. A Windows BOM silently breaks a
 * manifest (probe P26), and a `SessionStart` hook would never fire with the
 * values Claude exports (P9/P13) — both are pinned here.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.join(pkgRoot, "..", "..");

// Deliberate: the plugin id is the same as the Claude Code adapter's id, so
// Grok's same-name precedence shadows a claude-harnmem plugin that Grok
// auto-discovers from ~/.claude/plugins/ (probe P28/P29) instead of running a
// duplicate `harnmem` MCP server and duplicate SessionEnd extractor.
const PLUGIN_NAME = "harnmem";

async function readJson(rel) {
  const file = path.join(pkgRoot, rel);
  assert.ok(existsSync(file), `${rel} missing`);
  const bytes = await readFile(file);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${rel} starts with a UTF-8 BOM`);
  return JSON.parse(bytes.toString("utf8"));
}

test("manifests agree with package.json and share the Claude adapter's plugin id", async () => {
  const pkg = await readJson("package.json");
  const grokManifest = await readJson(".grok-plugin/plugin.json");
  const claudeManifest = await readJson(".claude-plugin/plugin.json");

  assert.equal(pkg.name, "grok-harnmem", "the npm/package name stays harness-specific");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(grokManifest.name, PLUGIN_NAME);
  assert.equal(claudeManifest.name, PLUGIN_NAME);
  assert.equal(grokManifest.version, pkg.version);
  assert.equal(claudeManifest.version, pkg.version);
  assert.equal(grokManifest.license, "MIT");
  assert.ok(pkg.files.includes(".grok-plugin/"));
  assert.ok(pkg.files.includes(".claude-plugin/"));
  assert.ok(pkg.files.includes("vendor/"), "installed plugin must ship the vendored core");

  const marketplace = JSON.parse(await readFile(path.join(repoRoot, ".grok-plugin", "marketplace.json"), "utf8"));
  const entry = marketplace.plugins.find((plugin) => plugin.name === PLUGIN_NAME);
  assert.ok(entry, "the root marketplace must list the plugin under the same id");
  assert.equal(entry.source.path, "./packages/grok-harnmem");
  assert.equal(entry.version, pkg.version);
});

test(".mcp.json wires the stdio server through ${GROK_PLUGIN_ROOT}", async () => {
  const mcp = await readJson(".mcp.json");
  const server = mcp.mcpServers.harnmem;
  assert.equal(server.type, "stdio");
  assert.equal(server.command, "node");
  assert.equal(server.args[0], "${GROK_PLUGIN_ROOT}/mcp/mcp.mjs");
  assert.ok(existsSync(path.join(pkgRoot, "mcp", "mcp.mjs")));
});

test("hooks register SessionEnd only (SessionStart injection is impossible in Grok)", async () => {
  const hooks = await readJson("hooks/hooks.json");
  assert.deepEqual(Object.keys(hooks.hooks), ["SessionEnd"]);
  const handler = hooks.hooks.SessionEnd[0].hooks[0];
  assert.equal(handler.type, "command");
  assert.match(handler.command, /\$\{GROK_PLUGIN_ROOT\}\/hooks\/hook\.mjs/);
  assert.equal(handler.timeout, 10);
  assert.ok(existsSync(path.join(pkgRoot, "hooks", "hook.mjs")));
});

test("commands and skills are discoverable components", async () => {
  const command = await readFile(path.join(pkgRoot, "commands", "memory.md"), "utf8");
  assert.match(command, /^---\n/);
  assert.match(command, /allowed-tools: .*harnmem__memory_search/);
  assert.match(command, /harnmem__memory_context/, "the command should expose the full-snapshot fallback");

  const skill = await readFile(path.join(pkgRoot, "skills", "harnmem-recall", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: harnmem-recall\n/);
  assert.match(skill, /memory_context/);
});

test("README documents the Grok-specific injection channel and coexistence rule", async () => {
  const readme = await readFile(path.join(pkgRoot, "README.md"), "utf8");
  assert.match(readme, /initialize\.instructions/);
  assert.match(readme, /SessionEnd/);
  assert.match(readme, /GROK_PLUGIN_ROOT|grok plugin/);
  assert.match(readme, /claude-harnmem/, "the README must explain the Claude-plugin coexistence");
  assert.match(readme, /same-name precedence|shadows/, "and why the shared plugin id matters");
});
