/**
 * Settings resolution for the Codex adapter.
 *
 * Priority (low -> high), matching docs/design/07-adapter-contract.md §7:
 *   1. `<home>/config.json` (default `~/.harnmem/config.json`)
 *   2. `<cwd>/.harnmem.json` (project config)
 *   3. environment variables (HARNMEM_HOME, HARNMEM_DISABLED, ...)
 *
 * Codex has no harness-level config file of its own, so the chain is the same
 * short one as Claude Code's. Malformed JSON is ignored, never fatal.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const KNOWN_KEYS = ["enabled", "readOnly", "inject", "autoExtract", "debug", "home", "project", "maxInjectTokens"];

const DEFAULTS = {
  enabled: true,
  readOnly: false,
  inject: true,
  autoExtract: false,
  debug: false,
  maxInjectTokens: 1200,
};

function truthy(value) {
  if (value === undefined) return undefined;
  const v = String(value).trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

/**
 * Expand a leading `~` to the user home (core does the same for its own home
 * resolution). Must run BEFORE path.resolve: resolving first would turn the
 * literal `~` segment into a real (wrong) directory and core would never see
 * it. Applies to HARNMEM_HOME and config-file "home" values alike.
 */
function expandHome(value) {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return path.join(homedir(), trimmed.slice(2));
  return value;
}

/** Coerce maxInjectTokens to a positive integer, regardless of source. */
function normalizeMaxInjectTokens(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
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

export function resolveSettings(cwd = process.cwd(), env = process.env) {
  const homeFromEnv = env.HARNMEM_HOME && env.HARNMEM_HOME.trim() ? path.resolve(expandHome(env.HARNMEM_HOME)) : undefined;
  const baseHome = homeFromEnv || path.join(homedir(), ".harnmem");

  let settings = { ...DEFAULTS };
  settings = { ...settings, ...pickKnown(readSettingsFile(path.join(baseHome, "config.json"))) };
  settings = { ...settings, ...pickKnown(readSettingsFile(path.join(cwd, ".harnmem.json"))) };

  // Config files have no schema: normalize the one numeric key that must not
  // reach core as a string ("1200" would poison token budget arithmetic).
  if (settings.maxInjectTokens !== DEFAULTS.maxInjectTokens) {
    settings.maxInjectTokens = normalizeMaxInjectTokens(settings.maxInjectTokens) ?? DEFAULTS.maxInjectTokens;
  }

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
  const fromEnvTokens = env.HARNMEM_CODEX_MAX_INJECT_TOKENS ? normalizeMaxInjectTokens(env.HARNMEM_CODEX_MAX_INJECT_TOKENS) : undefined;
  if (fromEnvTokens !== undefined) settings.maxInjectTokens = fromEnvTokens;

  const home =
    homeFromEnv ||
    (typeof settings.home === "string" && settings.home.trim() ? path.resolve(expandHome(settings.home)) : baseHome);

  return { ...settings, home };
}

export function debugEnabled(settings) {
  return settings.debug === true;
}
