import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

async function exists(target) {
  await access(target);
  return true;
}

test("the vendored engine and its assets are committed", async () => {
  const vendor = path.join(root, "vendor", "core");
  assert.ok(await exists(path.join(vendor, "index.js")));
  assert.ok(await exists(path.join(vendor, "prompts", "extract.md")));
  assert.ok(await exists(path.join(vendor, "data", "synonyms.en.txt")));
  assert.ok(await exists(path.join(vendor, "data", "synonyms.zh.txt")));
  const core = await import(pathToFileURL(path.join(vendor, "index.js")).href);
  assert.equal(core.HARNMEM_API_VERSION, 1);
});

test("the manifest declares the memory provider and its Node dependency", async () => {
  const manifest = await readFile(path.join(root, "plugin.yaml"), "utf8");
  assert.match(manifest, /^name: harnmem$/m);
  assert.match(manifest, /^requires_hermes: ">=0\.22\.5"$/m);
  assert.match(manifest, /external_dependencies:/);
  assert.match(manifest, /node --version/);
});

test("the provider entry point implements the Hermes registration hooks", async () => {
  const source = await readFile(path.join(root, "__init__.py"), "utf8");
  assert.match(source, /class HarnmemMemoryProvider\(MemoryProvider\)/);
  assert.match(source, /def register\(ctx\)/);
  assert.match(source, /ctx\.register_memory_provider\(/);
  assert.match(source, /def get_tool_schemas\(/);
  assert.match(source, /def save_config\(/);
  assert.match(source, /def on_session_end\(/);
});

test("the CLI module exposes the handler name Hermes looks up", async () => {
  const source = await readFile(path.join(root, "cli.py"), "utf8");
  assert.match(source, /def register_cli\(subparser/);
  assert.match(source, /def harnmem_command\(/);
});
