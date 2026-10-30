/**
 * Memory lifecycle: value scoring, dedupe classification, bi-temporal
 * supersede, and retention rules. Pure functions so every decision is
 * reproducible and testable. See docs/design/04-write-and-lifecycle.md.
 */
import type { HarnMemConfig, MemoryRecord, WriteInput } from "./types.js";
/** Content fingerprint used for exact-duplicate detection. */
export declare function contentHashOf(input: Pick<WriteInput, "title" | "description" | "content">): string;
export declare function simhashOf(input: Pick<WriteInput, "title" | "description" | "content">): bigint;
/** Record-level simhash (same weighting). */
export declare function recordSimhash(record: MemoryRecord): bigint;
/** Jaccard over character 3-grams of title+description+body. */
export declare function contentSimilarity(a: Pick<WriteInput, "title" | "description" | "content">, b: Pick<WriteInput, "title" | "description" | "content">): number;
/** Value in [0,1]: importance, confidence, usage, pin, source trust, recency. */
export declare function valueScore(record: MemoryRecord, now: number): number;
/** Ebbinghaus strength S in days; grows with value and usage. */
export declare function strengthDays(record: MemoryRecord, now: number): number;
/** Retention probability R = exp(-t/S). */
export declare function retention(record: MemoryRecord, now: number): number;
export type RetentionAction = "keep" | "archive" | "trash";
/** Decide whether a record should move down one lifecycle state. */
export declare function retentionDecision(record: MemoryRecord, now: number): RetentionAction;
/** Archived records that are cold and unused can be moved to trash. */
export declare function trashDecision(record: MemoryRecord, now: number): boolean;
/** True when the record is past its type TTL (stale signal in ranking). */
export declare function isStale(record: MemoryRecord, now: number, config: HarnMemConfig): boolean;
export type DedupeAction = "add" | "skip" | "merge" | "supersede" | "link";
export interface DedupeDecision {
    action: DedupeAction;
    target?: MemoryRecord;
    reason: string;
    /** Links to add to the incoming record. */
    links: string[];
    /** Merged record when action is merge (old id is kept). */
    merged?: MemoryRecord;
    similarity?: number;
}
/** Extract numeric/date/version tokens; used to detect factual conflicts. */
export declare function extractValues(text: string): Set<string>;
/**
 * Classify an incoming memory against existing candidates.
 * Order matters: exact dup -> skip; near dup (strong evidence) -> merge;
 * factual contradiction under the same topic -> supersede; related -> link.
 */
export declare function decideDedupe(source: WriteInput | MemoryRecord, candidates: MemoryRecord[], now: number): DedupeDecision;
/** Merge new input into an existing record, keeping the old id stable. */
export declare function mergeIntoRecord(old: MemoryRecord, source: WriteInput | MemoryRecord, now: number): MemoryRecord;
/** Apply a supersede transition to the old record. */
export declare function supersedeOld(old: MemoryRecord, newId: string, now: number): MemoryRecord;
//# sourceMappingURL=lifecycle.d.ts.map