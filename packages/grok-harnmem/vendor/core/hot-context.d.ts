import type { HarnMemConfig } from "./types.js";
/** Options accepted by {@link renderHotContextSync}. */
export interface SyncHotContextOptions {
    /** HarnMem home (already resolved; no `~` expansion here). */
    home: string;
    /** Working directory used to pick the project shard. */
    cwd?: string;
    /** Clock override for deterministic tests. */
    now?: number;
    /** Budget/retrieval overrides; omitted fields fall back to defaults. */
    config?: Partial<Pick<HarnMemConfig, "budget" | "retrieval">>;
}
/** Result of the synchronous cold-start render. */
export interface SyncHotContextResult {
    text: string;
    ids: string[];
    tokensEstimate: number;
    projectId: string | null;
    shards: string[];
}
/**
 * Render the injected hot-index block synchronously from disk.
 *
 * @returns the same block shape as `HarnMem.ensureContext()`, or an empty
 * `text` when the store has no active memory for the scopes in play.
 */
export declare function renderHotContextSync(options: SyncHotContextOptions): SyncHotContextResult;
//# sourceMappingURL=hot-context.d.ts.map