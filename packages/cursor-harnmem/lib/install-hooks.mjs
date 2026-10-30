/**
 * Pure helpers that merge/remove HarnMem's hook entries in a Cursor
 * `hooks.json` document. The installer (`scripts/install.mjs`) does the file
 * I/O; everything decision-shaped lives here so it is testable without a
 * Cursor installation.
 *
 * Why merge instead of write: a Cursor user's `~/.cursor/hooks.json` is shared
 * with their own hooks (and with other plugins' installers). Overwriting it is
 * the failure mode this project explicitly avoids, so every entry we add is
 * appended and every entry we remove is matched by its command path.
 */

/** Hook registrations this adapter depends on. */
export const HARNMEM_HOOKS = [
  { event: "beforeSubmitPrompt", argument: "beforeSubmitPrompt", timeout: 20 },
  // Confirmation event: a successful response marks the conversation as
  // injected so later prompts skip the engine boot (a failed first turn is
  // retried with a fresh injection instead).
  { event: "afterAgentResponse", argument: "afterAgentResponse", timeout: 10 },
  { event: "sessionEnd", argument: "sessionEnd", timeout: 10 },
];

/**
 * Read a Cursor JSON config (`hooks.json`, `mcp.json`). A UTF-8 BOM is
 * tolerated because Windows editors add one; `undefined` means "file absent".
 */
export async function readJsonFile(file, readFile) {
  const raw = await readFile(file, "utf8");
  return JSON.parse(raw.replace(/^\uFEFF/, ""));
}

/** Cursor executes hook commands through PowerShell (Windows) or a shell. */
export function hookCommand(hookScriptPath, argument) {
  return `node "${hookScriptPath}" ${argument}`;
}

function normalizeCommand(command) {
  return String(command ?? "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

/** Does this command string invoke our hook script? */
export function referencesHookScript(command, hookScriptPath) {
  if (typeof command !== "string" || !command.trim()) return false;
  const normalizedScript = normalizeCommand(hookScriptPath);
  return normalizeCommand(command).includes(normalizedScript);
}

function ensureHooksObject(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("hooks.json must contain a JSON object");
  }
  const hooks = config.hooks;
  if (hooks === undefined || hooks === null) {
    config.hooks = {};
    return config.hooks;
  }
  if (typeof hooks !== "object" || Array.isArray(hooks)) {
    throw new TypeError('hooks.json "hooks" must be an object keyed by event name');
  }
  return hooks;
}

function readEntries(hooks, event) {
  const list = hooks[event];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new TypeError(`hooks.json entry for "${event}" must be an array`);
  return list;
}

/**
 * Return a new hooks.json document with both HarnMem entries ensured.
 * `existing` is left untouched (structuredClone).
 *
 * @returns {{ config: object, added: string[], changed: boolean }}
 */
export function mergeHooksConfig(existing, { hookScriptPath }) {
  if (typeof hookScriptPath !== "string" || !hookScriptPath.trim()) {
    throw new TypeError("hookScriptPath is required");
  }
  const config = existing === undefined || existing === null ? {} : structuredClone(existing);
  const hooks = ensureHooksObject(config);
  if (typeof config.version !== "number") config.version = 1;
  const added = [];
  for (const spec of HARNMEM_HOOKS) {
    const list = readEntries(hooks, spec.event);
    const already = list.some(
      (entry) => entry && typeof entry === "object" && referencesHookScript(entry.command, hookScriptPath),
    );
    if (already) continue;
    list.push({
      command: hookCommand(hookScriptPath, spec.argument),
      timeout: spec.timeout,
      failClosed: false,
    });
    hooks[spec.event] = list;
    added.push(spec.event);
  }
  return { config, added, changed: added.length > 0 };
}

/**
 * Return a new hooks.json document with every HarnMem entry removed. Entries
 * that belong to the user or to other tools are preserved verbatim, as are
 * events that still have entries left.
 *
 * @returns {{ config: object, removed: number }}
 */
export function removeHooksConfig(existing, { hookScriptPath }) {
  const config = existing === undefined || existing === null ? {} : structuredClone(existing);
  const hooks = ensureHooksObject(config);
  let removed = 0;
  for (const spec of HARNMEM_HOOKS) {
    const list = readEntries(hooks, spec.event);
    const kept = list.filter((entry) => {
      const ours = entry && typeof entry === "object" && referencesHookScript(entry.command, hookScriptPath);
      if (ours) removed += 1;
      return !ours;
    });
    if (kept.length === 0) delete hooks[spec.event];
    else hooks[spec.event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete config.hooks;
  return { config, removed };
}

/** Merge the HarnMem MCP server into a `mcp.json` document. */
export function mergeMcpConfig(existing, { pluginRoot }) {
  const config = existing === undefined || existing === null ? {} : structuredClone(existing);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("mcp.json must contain a JSON object");
  }
  if (config.mcpServers !== undefined && (typeof config.mcpServers !== "object" || config.mcpServers === null)) {
    throw new TypeError('mcp.json "mcpServers" must be an object');
  }
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers.harnmem = {
    type: "stdio",
    command: "node",
    args: [`${String(pluginRoot).replace(/\\/g, "/")}/mcp/mcp.mjs`],
  };
  return config;
}

/** Remove the HarnMem MCP server from a `mcp.json` document. */
export function removeMcpConfig(existing) {
  const config = existing === undefined || existing === null ? {} : structuredClone(existing);
  if (config && typeof config === "object" && !Array.isArray(config) && config.mcpServers) {
    delete config.mcpServers.harnmem;
    if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
  }
  return config;
}
