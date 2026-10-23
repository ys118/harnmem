/**
 * Plugin configuration: schemastery schema (so the host can render/validate
 * config) plus a dependency-free resolver that `apply()` uses on every path.
 * Defaults live in `DEFAULT_SETTINGS` only — the schema mirrors them.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";

/** File-log verbosity: `off` = no file, `errors` = error-only, `on` = debug+. */
export type LogMode = "off" | "errors" | "on";

/** Raw config as written in a profile's cordis.patch.yml (all keys optional). */
export interface DshHarnMemConfig {
  home?: string;
  injectMaxTokens?: number;
  hotEntries?: number;
  autoExtract?: boolean;
  projectScope?: boolean;
  llmTimeoutMs?: number;
  consolidateEveryWrites?: number;
  /**
   * Prefix for the five model-facing tools. `harnmem_` avoids the bare
   * `memory_*` names, which `dsh-auto-memory` also registers (first registrant
   * wins in DSH, so the bare names silently point at auto-memory instead).
   */
  toolPrefix?: string;
  /** File log at `<home>/logs/dsh.jsonl`. Defaults to `on` during the trial. */
  log?: LogMode;
}

/** Config after defaults and environment overrides. */
export interface EffectiveSettings {
  home: string;
  injectMaxTokens: number;
  hotEntries: number;
  autoExtract: boolean;
  projectScope: boolean;
  llmTimeoutMs: number;
  consolidateEveryWrites: number;
  toolPrefix: string;
  log: LogMode;
}

export const DEFAULT_SETTINGS: Omit<EffectiveSettings, "home"> = {
  injectMaxTokens: 1200,
  hotEntries: 24,
  autoExtract: true,
  projectScope: true,
  // Session-end extraction is an auxiliary LLM call racing host teardown. A
  // measured deepseek-v4-flash extraction (3 memories, ~1.1 KB JSON) took
  // ~11.2 s through the plugin bridge; 8 s cut every real extraction off at the
  // dispose race (docs/research/dsh-write-silence-2026-10-23.md, N2 rerun).
  // The budget only delays dispose work the host does not await; at process
  // unload the provider adapters are already gone and the call fails in ms.
  llmTimeoutMs: 20000,
  consolidateEveryWrites: 25,
  toolPrefix: "harnmem_",
  // Trial default: the silent-write incident (docs/research/dsh-write-silence-2026-10-23.md)
  // was undiagnosable because nothing was logged. `errors` is the quiet setting;
  // `on` costs ~1–2 KB per session and makes extraction skips visible.
  log: "on",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmpty(...values: Array<unknown>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "on") return true;
    if (normalized === "false" || normalized === "0" || normalized === "off") return false;
  }
  return fallback;
}

/**
 * Tool prefixes are model-facing identifiers: letters/digits/underscore, and
 * must start with a letter so the name is a valid tool id. Anything invalid
 * falls back to the default instead of producing unusable names.
 */
function toToolPrefix(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(trimmed)) return fallback;
  return trimmed.endsWith("_") ? trimmed : `${trimmed}_`;
}

function toLogMode(value: unknown, fallback: LogMode): LogMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "off" || normalized === "errors" || normalized === "on" ? normalized : fallback;
}

/**
 * Resolve effective settings. Priority (07-adapter-contract §7):
 * `HARNMEM_HOME` > config `home` > `~/.harnmem`; `HARNMEM_TOOL_PREFIX` and
 * `HARNMEM_LOG` override the matching config keys.
 */
export function resolveSettings(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): EffectiveSettings {
  const input: Record<string, unknown> = isRecord(raw) ? raw : {};
  const home = firstNonEmpty(env["HARNMEM_HOME"], input["home"]) ?? join(homedir(), ".harnmem");
  return {
    home,
    injectMaxTokens: toInt(input["injectMaxTokens"], DEFAULT_SETTINGS.injectMaxTokens, 200, 8000),
    hotEntries: toInt(input["hotEntries"], DEFAULT_SETTINGS.hotEntries, 4, 200),
    autoExtract: toBool(input["autoExtract"], DEFAULT_SETTINGS.autoExtract),
    projectScope: toBool(input["projectScope"], DEFAULT_SETTINGS.projectScope),
    llmTimeoutMs: toInt(input["llmTimeoutMs"], DEFAULT_SETTINGS.llmTimeoutMs, 1000, 120_000),
    consolidateEveryWrites: toInt(
      input["consolidateEveryWrites"],
      DEFAULT_SETTINGS.consolidateEveryWrites,
      0,
      1000,
    ),
    toolPrefix: toToolPrefix(env["HARNMEM_TOOL_PREFIX"] ?? input["toolPrefix"], DEFAULT_SETTINGS.toolPrefix),
    log: toLogMode(env["HARNMEM_LOG"] ?? input["log"], DEFAULT_SETTINGS.log),
  };
}

// ---------------------------------------------------------------------------
// schemastery schema (exported to the host for config validation/rendering)
// ---------------------------------------------------------------------------

/**
 * Plugin config schema exported to the host. Every key mirrors
 * `DEFAULT_SETTINGS` and is optional, so an empty profile config is valid.
 */
export const Config = Schema.object({
  home: Schema.string().default(""),
  injectMaxTokens: Schema.number().default(DEFAULT_SETTINGS.injectMaxTokens),
  hotEntries: Schema.number().default(DEFAULT_SETTINGS.hotEntries),
  autoExtract: Schema.boolean().default(DEFAULT_SETTINGS.autoExtract),
  projectScope: Schema.boolean().default(DEFAULT_SETTINGS.projectScope),
  llmTimeoutMs: Schema.number().default(DEFAULT_SETTINGS.llmTimeoutMs),
  consolidateEveryWrites: Schema.number().default(DEFAULT_SETTINGS.consolidateEveryWrites),
  toolPrefix: Schema.string().default(DEFAULT_SETTINGS.toolPrefix),
  log: Schema.string().default(DEFAULT_SETTINGS.log),
});
