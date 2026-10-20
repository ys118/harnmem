/**
 * Plugin configuration: schemastery schema (so the host can render/validate
 * config) plus a dependency-free resolver that `apply()` uses on every path.
 * Defaults live in `DEFAULT_SETTINGS` only — the schema mirrors them.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import Schema from "@deepseek-ai/schemastery";

/** Raw config as written in a profile's cordis.patch.yml (all keys optional). */
export interface DshHarnMemConfig {
  home?: string;
  injectMaxTokens?: number;
  hotEntries?: number;
  autoExtract?: boolean;
  projectScope?: boolean;
  llmTimeoutMs?: number;
  consolidateEveryWrites?: number;
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
}

export const DEFAULT_SETTINGS: Omit<EffectiveSettings, "home"> = {
  injectMaxTokens: 1200,
  hotEntries: 24,
  autoExtract: true,
  projectScope: true,
  llmTimeoutMs: 8000,
  consolidateEveryWrites: 25,
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
 * Resolve effective settings. Priority (07-adapter-contract §7):
 * `HARNMEM_HOME` > config `home` > `~/.harnmem`.
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
});
