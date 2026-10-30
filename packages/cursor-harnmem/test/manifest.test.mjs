import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relative) {
  return JSON.parse(readFileSync(join(packageRoot, relative), "utf8"));
}

const manifest = readJson(".cursor-plugin/plugin.json");
const pkg = readJson("package.json");

test("plugin manifest carries the fields the Cursor marketplace requires", () => {
  assert.equal(manifest.name, "harnmem");
  assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(typeof manifest.description, "string");
  assert.ok(manifest.description.length > 40);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.license, "MIT");
  assert.equal(typeof manifest.author?.name, "string");
  assert.equal(manifest.repository, "https://github.com/ys118/harnmem");
});

test("listing logo is a square PNG with a background plate", () => {
  assert.equal(manifest.logo, "./logo.png");
  const bytes = readFileSync(join(packageRoot, "logo.png"));
  // PNG magic number.
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "logo.png must be a PNG",
  );
  // IHDR width/height live at bytes 16..24 (big-endian uint32 each).
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(width, height, "marketplace wants a 1:1 logo");
  assert.ok(width >= 512, `logo must be at least 512px, got ${width}`);
  // Colour type 2 or 6 means a background plate is baked in rather than
  // relying on the viewer's surface.
  const colorType = bytes[25];
  assert.ok([2, 6].includes(colorType), `unexpected PNG colour type ${colorType}`);
});

test("logo ships in the npm tarball and next to the manifest", () => {
  assert.ok(pkg.files.includes("logo.png"), "package.json files must include logo.png");
  assert.ok(pkg.files.includes(".cursor-plugin/"), "manifest directory must be published");
  assert.ok(statSync(join(packageRoot, "logo.png")).isFile());
});

test("hooks and MCP declarations point at shipped files", () => {
  assert.equal(manifest.hooks, "hooks/hooks.json");
  assert.equal(manifest.mcpServers, "mcp.json");

  const hooks = readJson(manifest.hooks);
  assert.equal(hooks.version, 1);
  for (const event of ["beforeSubmitPrompt", "afterAgentResponse", "sessionEnd"]) {
    const entries = hooks.hooks[event];
    assert.ok(Array.isArray(entries) && entries.length === 1, `${event} must have one entry`);
    assert.equal(entries[0].type, undefined);
    assert.match(entries[0].command, /hooks\/hook\.mjs/);
    assert.ok(Number.isInteger(entries[0].timeout) && entries[0].timeout > 0);
  }

  const mcp = readJson(manifest.mcpServers);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["harnmem"]);
  assert.equal(mcp.mcpServers.harnmem.type, "stdio");
  assert.equal(mcp.mcpServers.harnmem.command, "node");
  assert.match(mcp.mcpServers.harnmem.args[0], /\$\{CURSOR_PLUGIN_ROOT\}\/mcp\/mcp\.mjs$/);
});

test("always-apply rules file ships and documents the installer fallback", () => {
  const rules = readFileSync(join(packageRoot, "rules/harnmem.mdc"), "utf8");
  assert.match(rules, /^---\n[\s\S]*alwaysApply: true[\s\S]*?\n---\n/);
  assert.match(rules, /memory_search/);
  assert.match(rules, /`npx cursor-harnmem` enables automatic injection/);
});

test("the installer bin is reachable as both npx cursor-harnmem and npx cursor-harnmem-install", () => {
  // `npx cursor-harnmem` runs the package's sole bin; with two bins the name
  // that matches the package keeps that spelling explicit.
  assert.equal(pkg.bin["cursor-harnmem"], "scripts/install.mjs");
  assert.equal(pkg.bin["cursor-harnmem-install"], "scripts/install.mjs");
  assert.ok(pkg.files.includes("scripts/"), "the installer script must be published");
  assert.ok(statSync(join(packageRoot, "scripts/install.mjs")).isFile());

  const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
  assert.match(readme, /npx cursor-harnmem\b/);
  // The mistaken spelling is called out so nobody ships it in docs again.
  assert.match(readme, /`npx cursor-harnmem-install` on its own does \*\*not\*\* work/);
});
