/**
 * Tokenize text into index terms. CJK runs become character bigrams plus the
 * boundary unigrams (so single-character queries still match).
 *
 * `query: true` drops those boundary unigrams from multi-character runs: they
 * are artifacts of the bigram window (e.g. the trailing character of a longer
 * query phrase), and as query terms they matched unrelated documents through
 * one shared character (S6 abstain false positives). A genuinely
 * single-character query is kept.
 */
export declare function tokenize(text: string, opts?: {
    stopwords?: boolean;
    query?: boolean;
}): string[];
/** Token counts for a text field. */
export declare function termFreq(text: string): Map<string, number>;
export interface FieldConfig {
    title: number;
    description: number;
    tags: number;
    entities: number;
    body: number;
}
export declare const DEFAULT_FIELDS: FieldConfig;
/** Weighted term frequencies and weighted document length for BM25F. */
export declare function weightedTerms(fields: {
    title: string;
    description: string;
    tags: string[];
    entities: string[];
    body: string;
}, weights?: FieldConfig): {
    tf: Map<string, number>;
    len: number;
};
export interface Bm25Doc {
    /** weighted term frequency by term */
    tf: Map<string, number>;
    /** weighted document length */
    len: number;
    /** precomputed for convenience */
    id: string;
}
export interface Bm25Params {
    k1: number;
    b: number;
}
export declare const DEFAULT_BM25: Bm25Params;
export declare function idf(nDocs: number, df: number): number;
/**
 * Score a single doc for a set of unique query terms using precomputed postings.
 * `postings` maps term -> Map<docIdx, weighted tf> (built by the indexer).
 */
export declare function bm25fScore(queryTerms: string[], docIdx: number, postings: Map<string, Map<number, number>>, docLens: number[], avgLen: number, params?: Bm25Params): number;
/** First meaningful paragraph of a markdown body, trimmed for a snippet. */
export declare function extractSnippet(body: string, maxChars?: number): string;
/** Cos similarity between two token-count vectors (used by MMR). */
export declare function cosineTokens(a: Map<string, number>, b: Map<string, number>): number;
/**
 * Query token expansion via the built-in synonym table (zero LLM).
 *
 * Two guards keep expansion from *hurting* precision:
 *  - single-character CJK query tokens are boundary artifacts of the bigram
 *    tokenizer (for example one character of a longer word), not real
 *    concepts; they are not expanded.
 *  - a synonym phrase is re-tokenized, but single-character CJK tokens of that
 *    phrase are dropped. Without this, expanding a two-character query term
 *    injected stray characters that matched every album/note record (S6
 *    abstain false positives).
 */
export declare function expandQueryTerms(terms: string[], synonyms: Map<string, string[]>): string[];
/**
 * Parse simple Chinese/English time expressions into a [from, to] window.
 * Rules only; unknown expressions return null (caller falls back to text search).
 */
export declare function parseTimeExpression(query: string, now: number): {
    from: number;
    to: number;
} | null;
//# sourceMappingURL=text.d.ts.map