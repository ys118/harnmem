/**
 * Pure helpers behind `scripts/install.mjs --doctor`.
 *
 * Cursor imports Claude Code configuration on boot: when "Include Third-Party
 * Plugins, Skills, and Other Configs" (`thirdPartyExtensibilityEnabled`, on by
 * default) is enabled, a `claude-harnmem` plugin installed for Claude Code
 * shows up in Cursor as a second plugin named `harnmem`. Both copies ship an
 * MCP server called `harnmem` and the same hook scripts, so Cursor logs a
 * duplicate `claude-plugin config` hook (deduped by the hook's exclusive claim
 * files) and registers only one of the two MCP servers. The install itself is
 * fine; this module makes the duplicate visible instead of surprising.
 *
 * Everything here is decision-shaped and file-system free so it can be tested
 * without a Cursor or Claude Code installation.
 */

import path from "node:path";

import { HARNMEM_HOOKS, referencesHookScript } from "./install-hooks.mjs";

/** Plugin id both the Cursor and Claude Code adapters declare. */
export const HARNMEM_PLUGIN_ID = "harnmem";

/** Path to Claude Code's user-level plugin registry, relative to `~/.claude`. */
export const CLAUDE_PLUGIN_REGISTRY_PARTS = ["plugins", "installed_plugins.json"];

/** Resolve `<claude-config-dir>/plugins/installed_plugins.json`. */
export function claudePluginRegistryPath(claudeConfigDir) {
  return path.join(claudeConfigDir, ...CLAUDE_PLUGIN_REGISTRY_PARTS);
}

/**
 * Pull HarnMem installs out of a parsed `installed_plugins.json` document.
 *
 * The registry maps `<plugin>@<marketplace>` ids to an array of installs
 * (`{scope, installPath, version, ...}`). Anything malformed is ignored: this
 * is a diagnostic, not a validator.
 *
 * @returns {{ id: string, scope?: string, version?: string, installPath: string }[]}
 */
export function findClaudePluginInstalls(registry, pluginId = HARNMEM_PLUGIN_ID) {
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return [];
  const plugins = registry.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];
  const installs = [];
  for (const [id, entries] of Object.entries(plugins)) {
    if (typeof id !== "string" || !Array.isArray(entries)) continue;
    const bareId = id.split("@")[0];
    if (bareId !== pluginId) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (typeof entry.installPath !== "string" || !entry.installPath.trim()) continue;
      installs.push({
        id,
        scope: typeof entry.scope === "string" ? entry.scope : undefined,
        version: typeof entry.version === "string" ? entry.version : undefined,
        installPath: entry.installPath,
      });
    }
  }
  return installs;
}

/** Events from HARNMEM_HOOKS that `hooks.json` already registers for us. */
export function registeredHookEvents(hooksConfig, hookScriptPath) {
  const events = [];
  const hooks = hooksConfig?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return events;
  for (const spec of HARNMEM_HOOKS) {
    const list = hooks[spec.event];
    if (!Array.isArray(list)) continue;
    const registered = list.some(
      (entry) => entry && typeof entry === "object" && referencesHookScript(entry.command, hookScriptPath),
    );
    if (registered) events.push(spec.event);
  }
  return events;
}

function formatInstall(install) {
  const version = install.version ? ` ${install.version}` : "";
  return `${install.id}${version} (${install.installPath})`;
}

/**
 * Build the doctor report. `checks` carries one row per surface the adapter
 * needs; `warnings` and `problems` are preformatted lines for the installer.
 *
 * @returns {{
 *   checks: { id: string, status: "ok" | "warn" | "missing", detail: string }[],
 *   warnings: string[],
 *   problems: string[]
 * }}
 */
export function buildDoctorReport({
  pluginDir,
  pluginManifest,
  pluginMcpConfig,
  userMcpConfig,
  hooksConfig,
  hookScriptPath,
  claudeInstalls = [],
}) {
  const checks = [];
  const warnings = [];
  const problems = [];

  if (pluginManifest && pluginManifest.name === HARNMEM_PLUGIN_ID) {
    const version = pluginManifest.version ? ` ${pluginManifest.version}` : "";
    checks.push({ id: "plugin", status: "ok", detail: `${HARNMEM_PLUGIN_ID}${version} at ${pluginDir}` });
  } else {
    const detail = `no ${HARNMEM_PLUGIN_ID} plugin manifest at ${pluginDir}`;
    checks.push({ id: "plugin", status: "missing", detail });
    problems.push(`${detail} — run the installer without --doctor first`);
  }

  const registered = registeredHookEvents(hooksConfig, hookScriptPath);
  const expected = HARNMEM_HOOKS.map((spec) => spec.event);
  const missingEvents = expected.filter((event) => !registered.includes(event));
  if (missingEvents.length === 0) {
    checks.push({ id: "hooks", status: "ok", detail: `registered: ${registered.join(", ")}` });
  } else {
    const detail = `missing hook event(s): ${missingEvents.join(", ")}`;
    checks.push({ id: "hooks", status: "missing", detail });
    problems.push(`${detail} — rerun the installer to merge them into ~/.cursor/hooks.json`);
  }

  const pluginServer = pluginMcpConfig?.mcpServers?.[HARNMEM_PLUGIN_ID];
  const userServer = userMcpConfig?.mcpServers?.[HARNMEM_PLUGIN_ID];
  if (pluginServer) {
    checks.push({ id: "mcp", status: "ok", detail: `plugin mcp.json declares "${HARNMEM_PLUGIN_ID}" (stdio)` });
  } else if (userServer) {
    checks.push({ id: "mcp", status: "ok", detail: `user mcp.json declares "${HARNMEM_PLUGIN_ID}" (stdio)` });
  } else {
    const detail = `no "${HARNMEM_PLUGIN_ID}" MCP server in the plugin or ~/.cursor/mcp.json`;
    checks.push({ id: "mcp", status: "missing", detail });
    problems.push(`${detail} — the memory tools will not load; rerun the installer (or use --mcp-user)`);
  }

  if (claudeInstalls.length === 0) {
    checks.push({
      id: "claude-import",
      status: "ok",
      detail: "no HarnMem plugin in the Claude Code registry (Cursor will not import a duplicate)",
    });
  } else {
    const list = claudeInstalls.map(formatInstall).join("; ");
    checks.push({ id: "claude-import", status: "warn", detail: `Claude Code also has: ${list}` });
    warnings.push(
      "Cursor imports Claude Code plugins on boot, so Cursor will load a second plugin named " +
        `"${HARNMEM_PLUGIN_ID}" from ${list}.`,
    );
    warnings.push(
      "Both copies ship an MCP server named " +
        `"${HARNMEM_PLUGIN_ID}" (Cursor registers one) and the same hook scripts (deduped by the ` +
        "hook's exclusive claim files, so extraction does not run twice).",
    );
    warnings.push(
      "Fix: uncheck Settings > Chat > \"Include Third-Party Plugins, Skills, and Other Configs\", " +
        "or uninstall the Claude Code copy (`/plugin uninstall " +
        `${claudeInstalls[0].id}\`). Keeping both is harmless: injection and tools still come from ` +
        "this native Cursor plugin.",
    );
  }

  return { checks, warnings, problems };
}
