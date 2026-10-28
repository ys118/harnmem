/** ULID-like 26-char Crockford base32 id, time-sortable. */
export declare function newMemoryId(now?: number): string;
export declare function sha256Hex(input: string | Buffer): string;
export declare function sha1Hex(input: string | Buffer): string;
/** FNV-1a 64-bit as bigint (used for simhash feature hashing). */
export declare function fnv1a64(input: string): bigint;
/** 64-bit SimHash over weighted tokens (weights: Map token -> weight). */
export declare function simhash64(weights: Map<string, number>): bigint;
export declare function hamming64(a: bigint, b: bigint): number;
export declare function simhashHex(value: bigint): string;
export declare function parseSimhashHex(hex: string | undefined | null): bigint | null;
/** Jaccard similarity of two string sets (or arrays). */
export declare function jaccard(a: Iterable<string>, b: Iterable<string>): number;
/** Character n-grams (default 3) for CJK-friendly fuzzy comparison. */
export declare function charNgrams(text: string, n?: number): Set<string>;
export declare function normalizeForCompare(text: string): string;
export declare function normalizeNewlines(text: string): string;
/** Estimate tokens for mixed CJK/English text (chars/2.8 is conservative for zh). */
export declare function estimateTokens(text: string): number;
export declare function ensureDir(dir: string): Promise<void>;
export declare function atomicWriteFile(file: string, data: string): Promise<void>;
export declare function readJson<T>(file: string, fallback: T): Promise<T>;
export declare function writeJson(file: string, value: unknown): Promise<void>;
export declare function pathExists(path: string): Promise<boolean>;
export declare function readTextIfExists(file: string): Promise<string | null>;
export declare function expandHome(input: string): string;
export declare function resolveHome(input?: string): string;
export declare function truncateText(text: string, maxChars: number): string;
/** Deterministic date key in local time, e.g. 2026-10-20. */
export declare function dayKey(ts?: number): string;
export declare function parseTimestamp(value: number | string | undefined, fallback: number): number;
/** "2026-10-20" / ISO string -> end-of-day timestamp for as-of queries. */
export declare function parseAsOf(value: number | string, fallback: number): number;
export declare function clamp(value: number, min: number, max: number): number;
export declare function sortedUnique(values: Iterable<string>): string[];
export declare function sleep(ms: number): Promise<void>;
export declare function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T>;
//# sourceMappingURL=util.d.ts.map