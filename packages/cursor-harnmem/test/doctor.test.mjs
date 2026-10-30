import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildDoctorReport,
  claudePluginRegistryPath,
  findClaudePluginInstalls,
  registeredHookEvents,
} from "../lib/doctor.mjs";
import { HARNMEM_HOOKS, hookCommand, mergeHooksConfig } from "../lib/install-hooks.mjs";

const hookScript = "C:\\Users\\me\\.cursor\\plugins\\local\\harnmem\\hooks\\hook.mjs";
const pluginDir = "C:\\Users\\me\\.cursor\\plugins\\local\\harnmem";

function healthyHooksConfig() {
  return mergeHooksConfig(undefined, { hookScriptPath: hookScript }).config;
}

function pluginMcpConfig() {
  return {
    mcpServers: { harnmem: { type: "stdio", command: "node", args: ["${CURSOR_PLUGIN_ROOT}/mcp/mcp.mjs"] } },
  };
}

function claudeRegistry(...ids) {
  return {
    version: 2,
    plugins: Object.fromEntries(
      ids.map((id) => [
        id,
        [
          {
            scope: "user",
            installPath: `C:\\Users\\me\\.claude\\plugins\\cache\\${id.replace(/[:@]/g, "-")}`,
            version: "0.4.0",
          },
        ],
      ]),
    ),
  };
}

test("claudePluginRegistryPath resolves under the Claude config directory", () => {
  const claudeDir = path.join("home", "user", ".claude");
  assert.equal(
    claudePluginRegistryPath(claudeDir),
    path.join(claudeDir, "plugins", "installed_plugins.json"),
  );
  assert.equal(
    claudePluginRegistryPath(path.join("home", "user", ".claude")).endsWith(
      path.join("plugins", "installed_plugins.json"),
    ),
    true,
  );
});

test("findClaudePluginInstalls extracts HarnMem installs and ignores other plugins", () => {
  const registry = {
    version: 2,
    plugins: {
      "harnmem@harnmem-marketplace": [
        { scope: "user", installPath: "C:\\cache\\harnmem\\0.4.0", version: "0.4.0" },
      ],
      "other@some-marketplace": [{ scope: "user", installPath: "C:\\cache\\other" }],
      "not-harnmem@harnmem-marketplace": [{ scope: "user", installPath: "C:\\cache\\other2" }],
    },
  };
  const installs = findClaudePluginInstalls(registry);
  assert.equal(installs.length, 1);
  assert.equal(installs[0].id, "harnmem@harnmem-marketplace");
  assert.equal(installs[0].scope, "user");
  assert.equal(installs[0].version, "0.4.0");
  assert.equal(installs[0].installPath, "C:\\cache\\harnmem\\0.4.0");
});

test("findClaudePluginInstalls tolerates malformed registries", () => {
  assert.deepEqual(findClaudePluginInstalls(undefined), []);
  assert.deepEqual(findClaudePluginInstalls(null), []);
  assert.deepEqual(findClaudePluginInstalls("nope"), []);
  assert.deepEqual(findClaudePluginInstalls({ version: 2 }), []);
  assert.deepEqual(findClaudePluginInstalls({ plugins: [] }), []);
  assert.deepEqual(findClaudePluginInstalls({ plugins: { "harnmem@m": "nope" } }), []);
  assert.deepEqual(findClaudePluginInstalls({ plugins: { "harnmem@m": [null, { scope: "user" }] } }), []);
});

test("findClaudePluginInstalls returns every scope of one plugin", () => {
  const installs = findClaudePluginInstalls(
    {
      plugins: {
        "harnmem@harnmem-marketplace": [
          { scope: "user", installPath: "C:\\a", version: "0.4.0" },
          { scope: "project", installPath: "C:\\b" },
        ],
      },
    },
    "harnmem",
  );
  assert.deepEqual(
    installs.map((entry) => entry.installPath),
    ["C:\\a", "C:\\b"],
  );
});

test("registeredHookEvents matches our command path across separators and case", () => {
  const config = healthyHooksConfig();
  assert.deepEqual(
    registeredHookEvents(config, hookScript).sort(),
    HARNMEM_HOOKS.map((spec) => spec.event).sort(),
  );
  // A posix-style path with different separators/case still matches.
  const posix = "c:/USERS/me/.cursor/plugins/local/harnmem/hooks/hook.mjs";
  assert.deepEqual(
    registeredHookEvents(config, posix).sort(),
    HARNMEM_HOOKS.map((spec) => spec.event).sort(),
  );
});

test("registeredHookEvents ignores foreign commands and malformed documents", () => {
  const config = {
    version: 1,
    hooks: {
      beforeSubmitPrompt: [{ command: hookCommand("C:\\other\\hook.mjs", "beforeSubmitPrompt") }],
      afterAgentResponse: "not-an-array",
    },
  };
  assert.deepEqual(registeredHookEvents(config, hookScript), []);
  assert.deepEqual(registeredHookEvents(undefined, hookScript), []);
  assert.deepEqual(registeredHookEvents({ hooks: [] }, hookScript), []);
});

test("buildDoctorReport reports a healthy installation", () => {
  const report = buildDoctorReport({
    pluginDir,
    pluginManifest: { name: "harnmem", version: "0.1.0" },
    pluginMcpConfig: pluginMcpConfig(),
    hooksConfig: healthyHooksConfig(),
    hookScriptPath: hookScript,
    claudeInstalls: [],
  });
  assert.equal(report.problems.length, 0);
  assert.equal(report.warnings.length, 0);
  assert.deepEqual(
    report.checks.map((check) => check.status),
    ["ok", "ok", "ok", "ok"],
  );
  assert.match(report.checks[0].detail, /harnmem 0\.1\.0/);
  assert.match(report.checks[1].detail, /beforeSubmitPrompt/);
  assert.match(report.checks[2].detail, /plugin mcp\.json/);
});

test("buildDoctorReport accepts a user-level MCP server as the MCP surface", () => {
  const report = buildDoctorReport({
    pluginDir,
    pluginManifest: { name: "harnmem", version: "0.1.0" },
    userMcpConfig: pluginMcpConfig(),
    hooksConfig: healthyHooksConfig(),
    hookScriptPath: hookScript,
    claudeInstalls: [],
  });
  assert.equal(report.problems.length, 0);
  assert.match(report.checks.find((check) => check.id === "mcp").detail, /user mcp\.json/);
});

test("buildDoctorReport flags a missing plugin, hooks and MCP server", () => {
  const report = buildDoctorReport({
    pluginDir,
    pluginManifest: undefined,
    hooksConfig: undefined,
    hookScriptPath: hookScript,
    claudeInstalls: [],
  });
  assert.equal(report.problems.length, 3);
  assert.match(report.problems[0], /run the installer/);
  assert.match(report.problems[1], /rerun the installer/);
  assert.match(report.problems[2], /memory tools will not load/);
  assert.deepEqual(
    report.checks.map((check) => check.status),
    ["missing", "missing", "missing", "ok"],
  );
});

test("buildDoctorReport warns about a Claude Code copy of HarnMem", () => {
  const report = buildDoctorReport({
    pluginDir,
    pluginManifest: { name: "harnmem", version: "0.1.0" },
    pluginMcpConfig: pluginMcpConfig(),
    hooksConfig: healthyHooksConfig(),
    hookScriptPath: hookScript,
    claudeInstalls: findClaudePluginInstalls(claudeRegistry("harnmem@harnmem-marketplace")),
  });
  assert.equal(report.problems.length, 0);
  const claudeCheck = report.checks.find((check) => check.id === "claude-import");
  assert.equal(claudeCheck.status, "warn");
  assert.match(claudeCheck.detail, /harnmem@harnmem-marketplace/);
  assert.equal(report.warnings.length, 3);
  assert.match(report.warnings[0], /second plugin named "harnmem"/);
  assert.match(report.warnings[1], /exclusive claim files/);
  assert.match(report.warnings[2], /Include Third-Party Plugins, Skills, and Other Configs/);
  assert.match(report.warnings[2], /plugin uninstall harnmem@harnmem-marketplace/);
});

test("buildDoctorReport does not warn when the registry has no HarnMem plugin", () => {
  const report = buildDoctorReport({
    pluginDir,
    pluginManifest: { name: "harnmem", version: "0.1.0" },
    pluginMcpConfig: pluginMcpConfig(),
    hooksConfig: healthyHooksConfig(),
    hookScriptPath: hookScript,
    claudeInstalls: findClaudePluginInstalls(claudeRegistry("other@some-marketplace")),
  });
  assert.equal(report.warnings.length, 0);
  assert.equal(report.checks.find((check) => check.id === "claude-import").status, "ok");
});
