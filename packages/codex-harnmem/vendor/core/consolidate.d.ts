import type { ConsolidateOptions, ConsolidationReport, HarnMemConfig } from "./types.js";
import type { Store } from "./store.js";
import type { IndexManager } from "./indexer.js";
export declare class Consolidator {
    private readonly store;
    private readonly index;
    private readonly config;
    constructor(store: Store, index: IndexManager, config: HarnMemConfig);
    private now;
    run(opts?: ConsolidateOptions): Promise<ConsolidationReport>;
    private findDuplicates;
    private writeDigests;
}
//# sourceMappingURL=consolidate.d.ts.map