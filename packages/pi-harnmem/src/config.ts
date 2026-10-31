/**
 * Config resolution for the pi adapter.
 *
 * Priority (low -> high), matching docs/design/07-adapter-contract.md §7:
 *   1. `<home>/config.json` (default `~/.harnmem/config.json`)
 *   2. `<cwd>/.harnmem.json` (project config)
 *   3. `<agentDir>/harnmem.json` (pi harness config, default `~/.pi/agent/harnmem.json`)
 *   4. environment variables (HARNMEM_HOME, HARNMEM_DISABLED, HARNMEM_READONLY, ...)
 *
 * Every file is optional; malformed JSON only produces a warning.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type ReasoningEffort = "low" | "medium" | "high";
export type LogMode = "off" | "errors" | "on";

export interface PiHarnMemSettings {
  enabled?: boolean;
  /** Disable automatic extraction and refuse tool writes (read-only session). */
  readOnly?: boolean;
  /** Inject the hot-index snapshot into the system prompt. */
  inject?: boolean;
  /**
   * Show the footer status line (`harnmem: N entries · ~T tokens · <sha>`).
   * Default true; set false for a clean footer. `/memory status` keeps working.
   */
  statusLine?: boolean;
  /** Run endSession() extraction on quit (default false; costs an LLM call). */
  autoExtract?: boolean;
  /** Explicit harnmem home (default $HARNMEM_HOME or ~/.harnmem). */
  home?: string;
  /** Force a project id instead of resolving from cwd. */
  project?: string;
  /** Model used for extraction; defaults to the session model. */
  model?: {
    provider?: string;
    id?: string;
    reasoning?: ReasoningEffort;
    timeoutMs?: number;
  };
  /** Override hot-index token budget (engine default 1200). */
  maxInjectTokens?: number;
  /** Override search result token budget (engine default 1200). */
  maxSearchTokens?: number;
  /**
   * Prefix for the registered tool names (default `memory_`, giving
   * `memory_write`, `memory_search`, ...). Set another prefix such as
   * `harnmem_` to run side by side with an extension that already owns the
   * `memory_*` names (for example pi-memory).
   */
  toolPrefix?: string;
  log?: LogMode;
  debug?: boolean;
}

export interface EffectiveSettings {
  /** Fully merged settings object (file + env). */
  settings: PiHarnMemSettings;
  enabled: boolean;
  readOnly: boolean;
  inject: boolean;
  /** Draw the footer status line (default true). */
  statusLine: boolean;
  autoExtract: boolean;
  /** Prefix used for the registered tool names, e.g. `memory_` or `harnmem_`. */
  toolPrefix: string;
  log: LogMode;
  debug: boolean;
  home: string;
  agentDir: string;
  /** Config files that were successfully read, in load order. */
  sources: string[];
  warnings: string[];
}

const DEFAULTS = {
  enabled: true,
  readOnly: false,
  inject: true,
  statusLine: true,
  autoExtract: false,
  toolPrefix: "memory_",
  log: "errors" as LogMode,
  debug: false,
};

/**
 * Tool names are ASCII identifiers, so a prefix must match
 * /^[A-Za-z][A-Za-z0-9_]*$/; an empty prefix is allowed (tools named write/...).
 * Invalid values fall back to the default instead of breaking registration.
 */
function normalizeToolPrefix(value: string | undefined, warnings: string[]): string {
  if (value === undefined) return DEFAULTS.toolPrefix;
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(trimmed)) return trimmed;
  warnings.push(`config: invalid toolPrefix "${value}" (want /^[A-Za-z][A-Za-z0-9_]*$/); using "${DEFAULTS.toolPrefix}"`);
  return DEFAULTS.toolPrefix;
}

/** pi's own agent dir: honours PI_CODING_AGENT_DIR, else ~/.pi/agent. */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR;
  if (override && override.trim()) return path.resolve(override);
  return path.join(homedir(), ".pi", "agent");
}

function truthy(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

const BOOL_KEYS = ["enabled", "readOnly", "inject", "statusLine", "autoExtract", "debug"] as const;
const NUMBER_KEYS = ["maxInjectTokens", "maxSearchTokens"] as const;

/**
 * Config files are user-edited JSON with no schema: coerce boolean-ish strings
 * ("enabled": "false" must disable, not stay truthy) and the token budget
 * numbers ("1200" would poison core's budget arithmetic). Invalid values are
 * dropped so the effective-settings defaults apply; env overrides (applied
 * after this) already produce proper types.
 */
function coerceFileValues(settings: PiHarnMemSettings): PiHarnMemSettings {
  const rec = settings as unknown as Record<string, unknown>;
  for (const key of BOOL_KEYS) {
    const value = rec[key];
    if (value === undefined || typeof value === "boolean") continue;
    const coerced = truthy(String(value));
    if (coerced === undefined) delete rec[key];
    else rec[key] = coerced;
  }
  for (const key of NUMBER_KEYS) {
    const value = rec[key];
    if (value === undefined) continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) delete rec[key];
    else rec[key] = Math.floor(n);
  }
  return settings;
}

/**
 * Minimal JSONC support: strips // and served-up block comments outside strings.
 * Keeps line/column count irrelevant (config is only parsed, never printed).
 */
export function parseJsonc(raw: string): unknown {
  // Windows editors and PowerShell 5 commonly emit a UTF-8 BOM. JSON.parse
  // rejects a leading BOM; U+FEFF is ECMAScript WhiteSpace, so the trim() in
  // `JSON.parse(out.trim())` strips it (and any surrounding whitespace).
  let out = "";
  let i = 0;
  let inString = false;
  let quote = "";
  while (i < raw.length) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return JSON.parse(out.trim());
}

function readSettingsFile(file: string, warnings: string[], sources: string[]): PiHarnMemSettings | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = parseJsonc(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`config: ${file} is not a JSON object; ignored`);
      return undefined;
    }
    sources.push(file);
    return parsed as PiHarnMemSettings;
  } catch (err) {
    warnings.push(`config: failed to read ${file}: ${(err as Error).message}`);
    return undefined;
  }
}

function mergeSettings(base: PiHarnMemSettings, override: PiHarnMemSettings | undefined): PiHarnMemSettings {
  if (!override) return base;
  const merged: PiHarnMemSettings = { ...base, ...override };
  if (base.model || override.model) merged.model = { ...base.model, ...override.model };
  return merged;
}

/**
 * Expand a leading `~` to the real home directory. Applies to HARNMEM_HOME
 * and config-file "home" values alike (core's resolveHome does the same; a
 * literal `~` here would otherwise create a wrong store directory).
 */
function expandHome(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return path.join(homedir(), trimmed.slice(2));
  return value;
}

export function resolveSettings(cwd: string, env: NodeJS.ProcessEnv = process.env): EffectiveSettings {
  const warnings: string[] = [];
  const sources: string[] = [];
  const agentDir = resolveAgentDir(env);

  // 1. ~/.harnmem/config.json (or $HARNMEM_HOME/config.json when the env var is set).
  const baseHome = env.HARNMEM_HOME && env.HARNMEM_HOME.trim() ? path.resolve(expandHome(env.HARNMEM_HOME)) : path.join(homedir(), ".harnmem");
  let settings = mergeSettings({}, readSettingsFile(path.join(baseHome, "config.json"), warnings, sources));

  // 2. project config
  settings = mergeSettings(settings, readSettingsFile(path.join(cwd, ".harnmem.json"), warnings, sources));

  // 3. harness config
  settings = mergeSettings(settings, readSettingsFile(path.join(agentDir, "harnmem.json"), warnings, sources));

  // Config files have no schema: coerce boolean-ish strings ("enabled": "false"
  // must disable, not stay truthy) and the token budget number before env
  // overrides (which already produce proper types) on top.
  settings = coerceFileValues(settings);

  // 4. env overrides
  const envPatch: PiHarnMemSettings = {};
  if (truthy(env.HARNMEM_DISABLED) !== undefined) envPatch.enabled = !truthy(env.HARNMEM_DISABLED);
  if (truthy(env.HARNMEM_READONLY) !== undefined) envPatch.readOnly = truthy(env.HARNMEM_READONLY);
  if (truthy(env.HARNMEM_DEBUG) !== undefined) envPatch.debug = truthy(env.HARNMEM_DEBUG);
  if (truthy(env.HARNMEM_AUTO_EXTRACT) !== undefined) envPatch.autoExtract = truthy(env.HARNMEM_AUTO_EXTRACT);
  if (env.HARNMEM_INJECT !== undefined) {
    const on = truthy(env.HARNMEM_INJECT);
    if (on !== undefined) envPatch.inject = on;
  }
  if (truthy(env.HARNMEM_STATUS_LINE) !== undefined) envPatch.statusLine = truthy(env.HARNMEM_STATUS_LINE);
  if (env.HARNMEM_TOOL_PREFIX !== undefined) envPatch.toolPrefix = env.HARNMEM_TOOL_PREFIX;
  settings = mergeSettings(settings, envPatch);

  const home = env.HARNMEM_HOME && env.HARNMEM_HOME.trim() ? path.resolve(expandHome(env.HARNMEM_HOME)) : settings.home ? path.resolve(expandHome(settings.home)) : path.join(homedir(), ".harnmem");

  const debug = settings.debug ?? DEFAULTS.debug;
  const log: LogMode = settings.log ?? DEFAULTS.log;
  return {
    settings,
    enabled: settings.enabled ?? DEFAULTS.enabled,
    readOnly: settings.readOnly ?? DEFAULTS.readOnly,
    inject: settings.inject ?? DEFAULTS.inject,
    statusLine: settings.statusLine ?? DEFAULTS.statusLine,
    autoExtract: settings.autoExtract ?? DEFAULTS.autoExtract,
    toolPrefix: normalizeToolPrefix(settings.toolPrefix, warnings),
    log,
    debug,
    home,
    agentDir,
    sources,
    warnings,
  };
}
