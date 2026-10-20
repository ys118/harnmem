/**
 * Configuration: defaults, file loading and merge order.
 *
 * Precedence (low -> high):
 *   built-in defaults
 *   <home>/config.json
 *   <projectRoot>/.harnmem.json
 *   explicit options passed to HarnMem.open()
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  BudgetConfig,
  HarnMemConfig,
  GovernanceConfig,
  RetrievalConfig,
  WriteConfig,
} from "./types.js";
import { DEFAULT_FIELDS, type FieldConfig } from "./text.js";
import { readJson } from "./util.js";

export const DEFAULT_BUDGET: BudgetConfig = {
  injectTokens: 1200,
  searchTokens: 1200,
  hotEntries: 24,
  maxPinned: 10,
};

type FullRetrieval = RetrievalConfig;
type FullWrite = WriteConfig;
type FullGovernance = GovernanceConfig;

export const DEFAULT_RETRIEVAL: FullRetrieval = {
  k1: 1.2,
  b: 0.75,
  weights: { lex: 1.0, imp: 0.15, conf: 0.1, rec: 0.12, use: 0.08, pin: 0.25, link: 0.3, stale: 0.3 },
  decayPerHour: 0.995,
  mmrLambda: 0.7,
  // 0.10 keeps solid synonym-only matches answerable (a "go live" query still
  // matches a record that says "deploy", lex ≈ 0.14) while a query with no
  // lexical overlap at all abstains. S6-style false injections were caused by
  // polluted expansion terms, not by this knob.
  abstainLex: 0.1,
  ttlDays: { user: 365, feedback: 365, project: 180, reference: 365 },
  synonyms: true,
  linkDiffusion: true,
  mmr: true,
};

export const DEFAULT_WRITE: FullWrite = {
  autoExtract: true,
  skipExtractIfModelWrote: 1,
  minUserMessages: 3,
  minDigestChars: 500,
  maxPerRun: 6,
  minConfidence: 0.5,
  llmTimeoutMs: 12000,
};

export const DEFAULT_GOVERNANCE: FullGovernance = {
  maxUserRecords: 500,
  maxProjectRecords: 3000,
  maxBodyBytes: 65536,
  consolidateEveryWrites: 200,
  trashGraceDays: 30,
  archiveRetention: 180,
  archiveR0: 0.3,
};

export interface Defaults {
  home: string;
  harness: string;
  cwd: string;
  now: () => number;
  budget: BudgetConfig;
  retrieval: FullRetrieval;
  write: FullWrite;
  governance: FullGovernance;
}

export const DEFAULT_CONFIG: Defaults = {
  home: "",
  harness: "cli",
  cwd: process.cwd(),
  now: () => Date.now(),
  budget: DEFAULT_BUDGET,
  retrieval: DEFAULT_RETRIEVAL,
  write: DEFAULT_WRITE,
  governance: DEFAULT_GOVERNANCE,
};

export function mergeConfig(base: HarnMemConfig, override: HarnMemConfig | undefined): HarnMemConfig {
  if (!override) return base;
  const merged: HarnMemConfig = { ...base, ...override };
  if (override.budget) merged.budget = { ...(base.budget ?? DEFAULT_BUDGET), ...override.budget };
  if (override.retrieval) {
    const baseRetrieval = { ...DEFAULT_RETRIEVAL, ...(base.retrieval ?? {}) };
    const next = { ...baseRetrieval, ...override.retrieval };
    next.weights = { ...baseRetrieval.weights, ...(override.retrieval.weights ?? {}) };
    next.ttlDays = { ...baseRetrieval.ttlDays, ...(override.retrieval.ttlDays ?? {}) };
    merged.retrieval = next;
  }
  if (override.write) merged.write = { ...(base.write ?? DEFAULT_WRITE), ...override.write };
  if (override.governance) merged.governance = { ...(base.governance ?? DEFAULT_GOVERNANCE), ...override.governance };
  return merged;
}

async function readConfigFile(file: string): Promise<HarnMemConfig | null> {
  try {
    await fs.access(file);
  } catch {
    return null;
  }
  const parsed = await readJson<HarnMemConfig | null>(file, null);
  return parsed && typeof parsed === "object" ? parsed : null;
}

/**
 * Load config from the home config file and the project-local `.harnmem.json`
 * (if any), then apply explicit overrides.
 */
export async function loadConfig(
  home: string,
  projectRoot: string | undefined,
  explicit: HarnMemConfig | undefined,
): Promise<HarnMemConfig> {
  let config: HarnMemConfig = { ...DEFAULT_CONFIG, home };
  const globalFile = await readConfigFile(join(home, "config.json"));
  if (globalFile) config = mergeConfig(config, globalFile);
  if (projectRoot) {
    const localFile = await readConfigFile(join(projectRoot, ".harnmem.json"));
    if (localFile) config = mergeConfig(config, localFile);
  }
  config = mergeConfig(config, explicit);
  config.home = home;
  return config;
}

export function fieldsOf(config: HarnMemConfig): FieldConfig {
  return { ...DEFAULT_FIELDS, ...(config.retrieval?.fields ?? {}) };
}

/** Resolved ttl days for a type. */
export function ttlDays(config: HarnMemConfig, type: string): number {
  const ttl = config.retrieval?.ttlDays;
  if (!ttl) return 180;
  return (ttl as unknown as Record<string, number>)[type] ?? 180;
}

/** Resolved retrieval config with all defaults applied. */
export function retrievalOf(config: HarnMemConfig): FullRetrieval {
  return { ...DEFAULT_RETRIEVAL, ...(config.retrieval ?? {}), weights: { ...DEFAULT_RETRIEVAL.weights, ...(config.retrieval?.weights ?? {}) }, ttlDays: { ...DEFAULT_RETRIEVAL.ttlDays, ...(config.retrieval?.ttlDays ?? {}) } };
}

export function writeOf(config: HarnMemConfig): FullWrite {
  return { ...DEFAULT_WRITE, ...(config.write ?? {}) };
}

export function governanceOf(config: HarnMemConfig): FullGovernance {
  return { ...DEFAULT_GOVERNANCE, ...(config.governance ?? {}) };
}

export function budgetOf(config: HarnMemConfig): BudgetConfig {
  return { ...DEFAULT_BUDGET, ...(config.budget ?? {}) };
}
