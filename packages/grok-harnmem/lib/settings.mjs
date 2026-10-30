/**
 * Settings resolution for the Grok CLI adapter.
 *
 * Priority (low -> high), matching docs/design/07-adapter-contract.md §7:
 *   1. `<home>/config.json` (default `~/.harnmem/config.json`)
 *   2. `<cwd>/.harnmem.json` (project config)
 *   3. environment variables (HARNMEM_HOME, HARNMEM_DISABLED, ...)
 *
 * Grok's MCP servers inherit the process environment only, so there is no
 * harness-level config file in this chain (the plugin's config.toml section is
 * owned by Grok and read by the hook runner, not by our scripts). Malformed
 * JSON is ignored, never fatal.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const KNOWN_KEYS = [
  "enabled",
  "readOnly",
  "inject",
  "autoExtract",
  "debug",
  "home",
  "project",
  "maxInjectTokens",
  "maxInstructBytes",
];

const DEFAULTS = {
  enabled: true,
  readOnly: false,
  inject: true,
  autoExtract: false,
  debug: false,
  maxInjectTokens: 1200,
  // Grok truncates the aggregate "MCP servers connected" reminder at ~4.3 KB
  // (probe P19). Stay well below it so several other MCP servers with their
  // own instructions can still fit; the rest is reachable via memory_context.
  maxInstructBytes: 2500,
};

function truthy(value) {
  if (value === undefined) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

const BOOL_KEYS = ["enabled", "readOnly", "inject", "autoExtract", "debug"];

/**
 * Config files are user-edited JSON with no schema: coerce boolean-ish strings
 * the same way the env path does ("enabled": "false" must disable, not stay
 * truthy) and validate maxInjectTokens (a string would poison core's token
 * budget arithmetic).
 */
function coerceFileValues(settings) {
  for (const key of BOOL_KEYS) {
    if (typeof settings[key] !== "string") continue;
    const v = truthy(settings[key]);
    if (v === undefined) delete settings[key];
    else settings[key] = v;
  }
  // Invalid numbers fall back to the default, not to "absent": deleting the
  // key would strip the default that was merged in before file values applied.
  if (settings.maxInjectTokens !== undefined) {
    const n = Number(settings.maxInjectTokens);
    settings.maxInjectTokens = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULTS.maxInjectTokens;
  }
  if (settings.maxInstructBytes !== undefined) {
    const n = Number(settings.maxInstructBytes);
    settings.maxInstructBytes = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULTS.maxInstructBytes;
  }
  return settings;
}

function readSettingsFile(file) {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function pickKnown(source) {
  if (!source) return {};
  const out = {};
  // Skip null explicitly: "enabled": null in a config file must fall back to
  // the default (true), not be treated as a falsy override that disables the
  // store.
  for (const key of KNOWN_KEYS) {
    if (source[key] === undefined || source[key] === null) continue;
    out[key] = source[key];
  }
  return out;
}

/**
 * Expand a leading `~` to the real home directory. Applies to HARNMEM_HOME
 * and config-file "home" values alike (core's resolveHome does the same; a
 * literal `~` here would otherwise create a wrong store directory).
 */
function expandHome(value) {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return path.join(homedir(), trimmed.slice(2));
  return value;
}

export function resolveSettings(cwd = process.cwd(), env = process.env) {
  const baseHome =
    env.HARNMEM_HOME && env.HARNMEM_HOME.trim()
      ? path.resolve(expandHome(env.HARNMEM_HOME))
      : path.join(homedir(), ".harnmem");

  let settings = { ...DEFAULTS };
  settings = coerceFileValues({ ...settings, ...pickKnown(readSettingsFile(path.join(baseHome, "config.json"))) });
  settings = coerceFileValues({ ...settings, ...pickKnown(readSettingsFile(path.join(cwd, ".harnmem.json"))) });

  const disabled = truthy(env.HARNMEM_DISABLED);
  if (disabled !== undefined) settings.enabled = !disabled;
  const ro = truthy(env.HARNMEM_READONLY);
  if (ro !== undefined) settings.readOnly = ro;
  const dbg = truthy(env.HARNMEM_DEBUG);
  if (dbg !== undefined) settings.debug = dbg;
  const ae = truthy(env.HARNMEM_AUTO_EXTRACT);
  if (ae !== undefined) settings.autoExtract = ae;
  const inj = truthy(env.HARNMEM_INJECT);
  if (inj !== undefined) settings.inject = inj;
  if (env.HARNMEM_GROK_MAX_INJECT_TOKENS) {
    const n = Number(env.HARNMEM_GROK_MAX_INJECT_TOKENS);
    if (Number.isFinite(n) && n > 0) settings.maxInjectTokens = Math.floor(n);
  }
  if (env.HARNMEM_GROK_MAX_INSTRUCT_BYTES) {
    const n = Number(env.HARNMEM_GROK_MAX_INSTRUCT_BYTES);
    if (Number.isFinite(n) && n > 0) settings.maxInstructBytes = Math.floor(n);
  }

  const home =
    env.HARNMEM_HOME && env.HARNMEM_HOME.trim()
      ? path.resolve(expandHome(env.HARNMEM_HOME))
      : typeof settings.home === "string" && settings.home.trim()
        ? path.resolve(expandHome(settings.home))
        : baseHome;

  return { ...settings, home };
}

export function debugEnabled(settings) {
  return settings.debug === true;
}
