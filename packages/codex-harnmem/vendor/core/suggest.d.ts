/**
 * Offline synonym-table suggestions.
 *
 * The shipped tables are deliberately generic; every user's own corpus has
 * vocabulary that a generic dictionary cannot know (jargon, product names,
 * team slang). This module turns a local memory corpus into a bounded,
 * validated list of synonym groups that a human reviews and then adds to
 * `<home>/data/synonyms.<lang>.txt`.
 *
 * The engine never performs network I/O: `suggestSynonyms` takes an `LlmFn`
 * (the same contract extraction uses), so the CLI can bridge to any
 * OpenAI-compatible endpoint while adapters reuse their host model.
 *
 * Why the model, not statistics: the pairs worth adding (降级 ↔ 兜底,
 * 灰度 ↔ 分批发布) share no characters, so co-occurrence mining cannot discover
 * them. Precision is the risk, so the output is a proposal list — never an
 * automatic edit — and every group is validated against the corpus first.
 */
import type { LlmFn } from "./types.js";
/** Inline fallback used when `prompts/synonyms.md` is missing. */
export declare const DEFAULT_SUGGEST_PROMPT = "You maintain the synonym table of a personal memory store. The store is searched with BM25; Chinese text is tokenized into character bigrams, so two different phrasings of the same idea often share no characters. Your job: propose synonym groups that connect such phrasings.\n\nYou receive: the language, frequent terms found in the user's memories, up to a few dozen sample memories, and the existing synonym table.\n\nReturn JSON only:\n{\"groups\":[{\"canonical\":\"<term>\",\"synonyms\":[\"<term>\",\"<term>\"]}]}\n\nRules:\n1. Every term must occur in the samples or the candidate terms. Never invent vocabulary.\n2. A group means the entries are interchangeable for searching: a query using one should find memories that use another. Rewrites with no shared characters are the most valuable (e.g. \u964D\u7EA7 -> \u515C\u5E95, \u7070\u5EA6 -> \u5206\u6279\u53D1\u5E03).\n3. Do not propose synonyms that merely share a character or a substring, are grammatical variants of the same word, or are generic hypernyms. Ranking words (best, top, latest) and UI labels are not synonyms.\n4. 2-5 terms per group; canonical is the term most likely used in a search query.\n5. Skip anything already covered by the existing table.\n6. Do not propose words that are frequent in this user's domain but mean different things (homonyms across domains).\n7. If nothing is worth adding, return {\"groups\":[]}.\n8. Use the language of the memories for the terms. Output no markdown, no explanation.";
/** One memory (or journal message) the suggestion pass may read. */
export interface SuggestRecord {
    title?: string;
    description?: string;
    content?: string;
    tags?: string[];
    entities?: string[];
}
export interface SuggestMessage {
    role?: string;
    text?: string;
}
export interface SuggestOptions {
    /** Memory records (title/description/tags are the useful fields). */
    records?: SuggestRecord[];
    /** Optional session-journal messages; extra domain vocabulary. */
    messages?: SuggestMessage[];
    /** Existing groups to avoid re-proposing; loaded from <home> when omitted. */
    existing?: string[][];
    /** Language tag written into the prompt (default "zh"). */
    language?: string;
    /** Candidate terms kept for the prompt (default 120). */
    maxTerms?: number;
    /** A term must occur in at least this many records (default 2). */
    minSupport?: number;
    /** Samples sent to the model (default 16). */
    maxSamples?: number;
    /** Per-sample character budget (default 160). */
    sampleChars?: number;
    /** Accepted groups cap (default 24). */
    maxGroups?: number;
}
export interface HarvestedTerm {
    term: string;
    /** Number of records (or messages) that mention the term. */
    support: number;
    /** Weighted score: tags 3, entities 2, body text 1. */
    score: number;
}
export interface SuggestProposal {
    canonical: string;
    synonyms: string[];
}
export interface SuggestRejection {
    canonical: string;
    synonyms: string[];
    reason: string;
}
export interface SuggestPrompt {
    system: string;
    user: string;
    source: string;
    terms: HarvestedTerm[];
    /** True when the user template came from `prompts/synonyms.md`. */
    hasTemplate: boolean;
}
export interface SuggestRunResult {
    proposals: SuggestProposal[];
    rejected: SuggestRejection[];
    prompt: SuggestPrompt;
    /** Groups the model returned before validation. */
    parsedGroups: number;
}
/** Trim noise from a model-supplied term without changing its core. */
export declare function cleanTerm(raw: string): string;
/**
 * Frequency pass over the corpus. Then output is guidance for the model, not
 * a decision: the validator accepts canonicals that appear anywhere in the
 * corpus, so a sparse harvest can never veto a good proposal.
 */
export declare function harvestTerms(records?: SuggestRecord[], messages?: SuggestMessage[], opts?: {
    minSupport?: number;
    maxTerms?: number;
}): HarvestedTerm[];
/** Lowercased text used both for prompting and for validating canonicals. */
export declare function buildSuggestCorpus(records?: SuggestRecord[], messages?: SuggestMessage[]): string;
/**
 * Build the prompt from the shipped (or user-edited) `prompts/synonyms.md`
 * asset. The system section stays byte-stable; only the user section is
 * filled, matching the asset contract in `prompts/README.md`.
 */
export declare function buildSuggestPrompt(home: string, options: SuggestOptions): SuggestPrompt;
/** Tolerant JSON extraction: models like to wrap JSON in prose or fences. */
export declare function parseSuggestionGroups(text: string): {
    groups: SuggestProposal[];
    invalid: number;
};
/**
 * Validate model proposals against the corpus and the tables already in force.
 * Anything unverifiable is rejected with a reason instead of being written.
 */
export declare function validateSuggestions(groups: SuggestProposal[], opts: {
    terms?: HarvestedTerm[];
    corpus: string;
    existing?: string[][];
    maxGroups?: number;
}): {
    proposals: SuggestProposal[];
    rejected: SuggestRejection[];
};
/** Validate a model response that was produced elsewhere (offline workflow). */
export declare function suggestFromResponse(home: string, options: SuggestOptions, response: string): SuggestRunResult;
/** Run the whole suggestion pass with a caller-supplied model bridge. */
export declare function suggestSynonyms(home: string, options: SuggestOptions & {
    llm: LlmFn;
}): Promise<SuggestRunResult>;
//# sourceMappingURL=suggest.d.ts.map