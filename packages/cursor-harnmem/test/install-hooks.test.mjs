import assert from "node:assert/strict";
import test from "node:test";

import {
  HARNMEM_HOOKS,
  mergeHooksConfig,
  mergeMcpConfig,
  readJsonFile,
  referencesHookScript,
  removeHooksConfig,
  removeMcpConfig,
} from "../lib/install-hooks.mjs";

const hookScript = "C:\\Users\\me\\.cursor\\plugins\\local\\harnmem\\hooks\\hook.mjs";

test("mergeHooksConfig creates both events on an empty document", () => {
  const { config, added, changed } = mergeHooksConfig(undefined, { hookScriptPath: hookScript });
  assert.equal(changed, true);
  assert.deepEqual(added.sort(), HARNMEM_HOOKS.map((spec) => spec.event).sort());
  assert.equal(config.version, 1);
  for (const spec of HARNMEM_HOOKS) {
    const entries = config.hooks[spec.event];
    assert.equal(entries.length, 1);
    assert.ok(entries[0].command.startsWith("node \""));
    assert.ok(entries[0].command.includes(hookScript));
    assert.equal(entries[0].timeout, spec.timeout);
    assert.equal(entries[0].failClosed, false);
  }
});

test("mergeHooksConfig preserves user hooks and is idempotent", () => {
  const existing = {
    version: 1,
    hooks: {
      beforeSubmitPrompt: [{ command: "node \"C:\\tools\\mine.mjs\"", timeout: 5 }],
      afterFileEdit: [{ command: "node \"C:\\tools\\fmt.mjs\"" }],
    },
  };
  const first = mergeHooksConfig(existing, { hookScriptPath: hookScript });
  assert.equal(first.changed, true);
  assert.equal(first.config.hooks.beforeSubmitPrompt.length, 2, "user entry preserved, ours appended");
  assert.deepEqual(first.config.hooks.afterFileEdit, existing.hooks.afterFileEdit, "unrelated event untouched");

  const second = mergeHooksConfig(first.config, { hookScriptPath: hookScript });
  assert.equal(second.changed, false, "second install is a no-op");
  assert.deepEqual(second.config, first.config);

  // The input document is never mutated.
  assert.equal(existing.hooks.beforeSubmitPrompt.length, 1);
});

test("removeHooksConfig removes only HarnMem entries", () => {
  const merged = mergeHooksConfig(
    {
      version: 1,
      hooks: {
        beforeSubmitPrompt: [{ command: "node \"C:\\tools\\mine.mjs\"" }],
        sessionEnd: [{ command: "node \"C:\\tools\\other.mjs\"" }],
      },
    },
    { hookScriptPath: hookScript },
  ).config;
  const { config, removed } = removeHooksConfig(merged, { hookScriptPath: hookScript });
  assert.equal(removed, HARNMEM_HOOKS.length);
  assert.deepEqual(config.hooks.beforeSubmitPrompt, [{ command: "node \"C:\\tools\\mine.mjs\"" }]);
  assert.deepEqual(config.hooks.sessionEnd, [{ command: "node \"C:\\tools\\other.mjs\"" }]);
});

test("removeHooksConfig drops events that only held HarnMem entries", () => {
  const merged = mergeHooksConfig(undefined, { hookScriptPath: hookScript }).config;
  const { config, removed } = removeHooksConfig(merged, { hookScriptPath: hookScript });
  assert.equal(removed, HARNMEM_HOOKS.length);
  assert.equal(config.hooks, undefined, "empty hooks object is removed");
  assert.equal(config.version, 1);
});

test("malformed hook documents are rejected instead of overwritten", () => {
  assert.throws(() => mergeHooksConfig([], { hookScriptPath: hookScript }), /JSON object/);
  assert.throws(() => mergeHooksConfig({ hooks: [] }, { hookScriptPath: hookScript }), /keyed by event name/);
  assert.throws(() => mergeHooksConfig({ hooks: { sessionEnd: {} } }, { hookScriptPath: hookScript }), /must be an array/);
});

test("referencesHookScript matches across slash styles and rejects foreign commands", () => {
  const forward = "C:/Users/me/.cursor/plugins/local/harnmem/hooks/hook.mjs";
  assert.equal(referencesHookScript(`node "${forward}" sessionEnd`, hookScript), true);
  assert.equal(referencesHookScript(`node "${hookScript}" sessionEnd`, hookScript), true);
  assert.equal(referencesHookScript("node \"C:\\tools\\mine.mjs\"", hookScript), false);
  assert.equal(referencesHookScript(undefined, hookScript), false);
});

test("readJsonFile tolerates a UTF-8 BOM written by Windows editors", async () => {
  const doc = { version: 1, hooks: { sessionEnd: [] } };
  const body = `\uFEFF${JSON.stringify(doc, null, 2)}\n`;
  const readFile = async () => body;
  assert.deepEqual(await readJsonFile("C:/fake/hooks.json", readFile), doc);
});

test("MCP user config merges and removes only the harnmem server", () => {
  const existing = { mcpServers: { other: { command: "node", args: ["other.mjs"] } } };
  const merged = mergeMcpConfig(existing, { pluginRoot: "C:\\Users\\me\\.cursor\\plugins\\local\\harnmem" });
  assert.ok(merged.mcpServers.other, "unrelated server preserved");
  assert.deepEqual(merged.mcpServers.harnmem.args, [
    "C:/Users/me/.cursor/plugins/local/harnmem/mcp/mcp.mjs",
  ]);
  assert.equal(merged.mcpServers.harnmem.type, "stdio");

  const removed = removeMcpConfig(merged);
  assert.equal(removed.mcpServers.harnmem, undefined);
  assert.ok(removed.mcpServers.other);
  assert.equal(removeMcpConfig({}).mcpServers, undefined);
});
