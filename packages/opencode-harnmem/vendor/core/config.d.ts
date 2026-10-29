import type { BudgetConfig, HarnMemConfig, GovernanceConfig, RetrievalConfig, WriteConfig } from "./types.js";
import { type FieldConfig } from "./text.js";
export declare const DEFAULT_BUDGET: BudgetConfig;
type FullRetrieval = RetrievalConfig;
type FullWrite = WriteConfig;
type FullGovernance = GovernanceConfig;
export declare const DEFAULT_RETRIEVAL: FullRetrieval;
export declare const DEFAULT_WRITE: FullWrite;
export declare const DEFAULT_GOVERNANCE: FullGovernance;
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
export declare const DEFAULT_CONFIG: Defaults;
export declare function mergeConfig(base: HarnMemConfig, override: HarnMemConfig | undefined): HarnMemConfig;
/**
 * Load config from the home config file and the project-local `.harnmem.json`
 * (if any), then apply explicit overrides.
 */
export declare function loadConfig(home: string, projectRoot: string | undefined, explicit: HarnMemConfig | undefined): Promise<HarnMemConfig>;
export declare function fieldsOf(config: HarnMemConfig): FieldConfig;
/** Resolved ttl days for a type. */
export declare function ttlDays(config: HarnMemConfig, type: string): number;
/** Resolved retrieval config with all defaults applied. */
export declare function retrievalOf(config: HarnMemConfig): FullRetrieval;
export declare function writeOf(config: HarnMemConfig): FullWrite;
export declare function governanceOf(config: HarnMemConfig): FullGovernance;
export declare function budgetOf(config: HarnMemConfig): BudgetConfig;
export {};
//# sourceMappingURL=config.d.ts.map