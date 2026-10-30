export interface PromptAsset {
    name: string;
    version: number;
    /** Stable system prompt (no placeholders). */
    system: string;
    /** User template with {{placeholders}}; null for legacy single-string prompts. */
    user: string | null;
    /** Where the asset was read from (diagnostics). */
    source: string;
}
/** Repository/package root that contains `prompts/extract.md`, if discoverable. */
export declare function findAssetRoot(): string | null;
/** Read an asset, preferring the user's copy in <home>, then the shipped default. */
export declare function readAssetRaw(home: string, relativePath: string): {
    text: string;
    source: string;
} | null;
/**
 * Synonym tables available to the engine: shipped defaults plus the user's
 * editable copies, deduplicated by filename and sorted for deterministic
 * loading. A language is added by adding `data/synonyms.<lang>.txt` — no code
 * change; the `<home>` copy of a filename overrides the shipped default of the
 * same name.
 */
export declare function listSynonymFiles(home: string): string[];
/**
 * Parse one synonym table. Shipped format is `canonical<TAB>syn1,syn2`;
 * `=`, `:` and full-width `：` are accepted as separators too, and synonyms may
 * be separated by `,`, `，` or `、`. Blank lines and `#` comments are ignored.
 */
export declare function parseSynonymTable(raw: string): string[][];
/** All synonym groups from every discovered table; `files` is for diagnostics. */
export declare function loadSynonymGroups(home: string): {
    groups: string[][];
    files: string[];
};
/** Split a prompt file into stable system text + user template. */
export declare function parsePromptAsset(name: string, raw: string, source?: string): PromptAsset;
/** Load a prompt asset from <home>/prompts or the shipped defaults. */
export declare function loadPromptAsset(home: string, name: string): PromptAsset | null;
/** Replace `{{name}}` placeholders. Unknown placeholders are left in place on purpose. */
export declare function fillPrompt(template: string, vars: Record<string, string>): string;
export interface DeployResult {
    copied: string[];
    root: string | null;
}
/**
 * Copy shipped defaults into <home>/ the first time they are needed. Existing
 * user files are never overwritten. Returns copied paths (home-relative).
 */
export declare function deployDefaultAssets(home: string): DeployResult;
//# sourceMappingURL=assets.d.ts.map