/**
 * Memory lifecycle: value scoring, dedupe classification, bi-temporal
 * supersede, and retention rules. Pure functions so every decision is
 * reproducible and testable. See docs/design/04-write-and-lifecycle.md.
 */
import type { HarnMemConfig, MemoryRecord, MemoryType, WriteInput } from "./types.js";
import { ttlDays } from "./config.js";
import { termFreq, tokenize } from "./text.js";
import { trustOf } from "./indexer.js";
import {
  charNgrams,
  clamp,
  dayKey,
  jaccard,
  normalizeForCompare,
  parseSimhashHex,
  sha256Hex,
  simhash64,
  simhashHex,
  hamming64,
} from "./util.js";

const DAY = 86400000;

/** Content fingerprint used for exact-duplicate detection. */
export function contentHashOf(input: Pick<WriteInput, "title" | "description" | "content">): string {
  const normalized = normalizeForCompare(`${input.title}\n${input.description ?? ""}\n${input.content ?? ""}`);
  return sha256Hex(normalized).slice(0, 32);
}

export function simhashOf(input: Pick<WriteInput, "title" | "description" | "content">): bigint {
  const weights = new Map<string, number>();
  const add = (text: string, factor: number) => {
    for (const [token, n] of termFreq(text)) weights.set(token, (weights.get(token) ?? 0) + n * factor);
  };
  add(input.title, 3);
  add(input.description ?? "", 2);
  add(input.content ?? "", 1);
  return simhash64(weights);
}

/** Record-level simhash (same weighting). */
export function recordSimhash(record: MemoryRecord): bigint {
  return simhashOf(record);
}

/** Jaccard over character 3-grams of title+description+body. */
export function contentSimilarity(
  a: Pick<WriteInput, "title" | "description" | "content">,
  b: Pick<WriteInput, "title" | "description" | "content">,
): number {
  const gramsA = charNgrams(`${a.title} ${a.description ?? ""} ${a.content ?? ""}`);
  const gramsB = charNgrams(`${b.title} ${b.description ?? ""} ${b.content ?? ""}`);
  return jaccard(gramsA, gramsB);
}

/** Value in [0,1]: importance, confidence, usage, pin, source trust, recency. */
export function valueScore(record: MemoryRecord, now: number): number {
  const importance = clamp(record.importance / 10, 0, 1);
  const confidence = clamp(record.confidence, 0, 1);
  const usage = clamp(Math.log1p(record.usedCount) / Math.log1p(20), 0, 1);
  const pinned = record.pinned ? 1 : 0;
  const trust = trustOf(record.source.harness);
  const ageDays = Math.max(0, (now - (record.lastUsed || record.updated || record.created)) / DAY);
  const recency = Math.exp(-ageDays / 90);
  return clamp(0.35 * importance + 0.2 * confidence + 0.15 * usage + 0.15 * pinned + 0.1 * trust + 0.05 * recency, 0, 1);
}

/** Ebbinghaus strength S in days; grows with value and usage. */
export function strengthDays(record: MemoryRecord, now: number): number {
  if (record.pinned) return Number.POSITIVE_INFINITY;
  const value = valueScore(record, now);
  return 14 * (0.5 + 2 * value) * (1 + Math.min(record.usedCount, 20) * 0.1);
}

/** Retention probability R = exp(-t/S). */
export function retention(record: MemoryRecord, now: number): number {
  if (record.pinned) return 1;
  const s = strengthDays(record, now);
  const t = Math.max(0, (now - (record.lastUsed || record.updated || record.created)) / DAY);
  return Math.exp(-t / s);
}

export type RetentionAction = "keep" | "archive" | "trash";

/** Decide whether a record should move down one lifecycle state. */
export function retentionDecision(record: MemoryRecord, now: number): RetentionAction {
  if (record.pinned || record.status !== "active") return "keep";
  if (record.type === "user" || record.type === "feedback") {
    // Durable preferences: archive only after a very long idle period; never auto-trash.
    const idleDays = (now - (record.lastUsed || record.updated || record.created)) / DAY;
    return idleDays > 730 ? "archive" : "keep";
  }
  const r = retention(record, now);
  if (r < 0.3) return "archive";
  return "keep";
}

/** Archived records that are cold and unused can be moved to trash. */
export function trashDecision(record: MemoryRecord, now: number): boolean {
  if (record.pinned || record.status !== "archived") return false;
  const idleDays = (now - (record.lastUsed || record.updated || record.created)) / DAY;
  return idleDays > 90 && retention(record, now) < 0.05;
}

/** True when the record is past its type TTL (stale signal in ranking). */
export function isStale(record: MemoryRecord, now: number, config: HarnMemConfig): boolean {
  if (record.pinned) return false;
  const ttl = ttlDays(config, record.type) * DAY;
  return now - (record.lastUsed || record.updated || record.created) > ttl;
}

// ---------------------------------------------------------------------------
// Dedupe / supersede
// ---------------------------------------------------------------------------

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

const NUMERIC_RE = /\b\d+(?:\.\d+){0,3}\b/g;

/** Extract numeric/date/version tokens; used to detect factual conflicts. */
export function extractValues(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.match(NUMERIC_RE) ?? []) out.add(m);
  for (const m of text.match(/\d{4}-\d{2}-\d{2}/g) ?? []) out.add(m);
  return out;
}

function conflicts(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const v of a) if (b.has(v)) return false;
  return true;
}

function tagOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const inter = a.filter((t) => setB.has(t)).length;
  return inter / Math.min(a.length, b.length);
}

function normalizedTitle(title: string): Set<string> {
  return charNgrams(normalizeForCompare(title), 3);
}

/**
 * Classify an incoming memory against existing candidates.
 * Order matters: exact dup -> skip; near dup (strong evidence) -> merge;
 * factual contradiction under the same topic -> supersede; related -> link.
 */
export function decideDedupe(
  source: WriteInput | MemoryRecord,
  candidates: MemoryRecord[],
  now: number,
): DedupeDecision {
  const input: WriteInput = "id" in source ? writeInputFromRecord(source as MemoryRecord) : (source as WriteInput);
  const incomingHash = contentHashOf(input);
  const incomingSim = simhashOf(input);
  const incomingValues = extractValues(`${input.title} ${input.description ?? ""} ${input.content ?? ""}`);
  const incomingTitleGrams = normalizedTitle(input.title);
  const links: string[] = [];
  let best: { record: MemoryRecord; sim: number; ham: number } | null = null;

  for (const record of candidates) {
    if (record.status === "dropped") continue;
    if (record.type !== (input.type ?? "project")) continue;
    if ((input.scope ?? record.scope) !== record.scope) continue;
    if (record.scope === "project" && input.project && record.project !== input.project) continue;

    const recordHash = contentHashOf(record);
    if (recordHash === incomingHash) {
      return { action: "skip", target: record, reason: "exact content hash", links: [] };
    }
    const ham = hamming64(incomingSim, recordSimhash(record));
    const sim = contentSimilarity(input, record);
    if (!best || sim > best.sim) best = { record, sim, ham };

    const titleSim = jaccard(incomingTitleGrams, normalizedTitle(record.title));
    if (ham <= 3 && sim >= 0.82) {
      return {
        action: "merge",
        target: record,
        reason: `near-duplicate (hamming=${ham}, jaccard=${sim.toFixed(2)})`,
        links: [],
        similarity: sim,
        merged: mergeIntoRecord(record, input, now),
      };
    }
    const recordValues = extractValues(`${record.title} ${record.description} ${record.content}`);
    const contradictory = conflicts(incomingValues, recordValues);
    // Same topic title + contradicting values is a supersede even when rewording
    // drops whole-body similarity (short memory bodies are common here).
    if (titleSim >= 0.85 && contradictory) {
      return {
        action: "supersede",
        target: record,
        reason: `conflicting values under near-identical title (titleSim=${titleSim.toFixed(2)})`,
        links: [],
        similarity: sim,
      };
    }
    if (ham <= 8 && sim >= 0.6) {
      if (contradictory && (titleSim >= 0.4 || tagOverlap(input.tags ?? [], record.tags) >= 0.5)) {
        return {
          action: "supersede",
          target: record,
          reason: `conflicting values under same topic (titleSim=${titleSim.toFixed(2)})`,
          links: [],
          similarity: sim,
        };
      }
      links.push(record.id);
    }
  }
  if (links.length > 0) {
    return { action: "link", reason: `related to ${links.length} existing memories`, links };
  }
  return { action: "add", reason: "no similar memory", links: [] };
}

/** Merge new input into an existing record, keeping the old id stable. */
export function mergeIntoRecord(old: MemoryRecord, source: WriteInput | MemoryRecord, now: number): MemoryRecord {
  const input: WriteInput = "id" in source ? writeInputFromRecord(source as MemoryRecord) : source;
  const mergedContent = pickFresherBody(old, input);
  return {
    ...old,
    title: old.title || input.title,
    description: input.description && input.description.length > old.description.length ? input.description : old.description,    content: mergedContent,
    tags: [...new Set([...old.tags, ...(input.tags ?? [])])].sort(),
    entities: [...new Set([...old.entities, ...(input.entities ?? [])])].sort(),
    importance: Math.max(old.importance, input.importance ?? old.importance),
    confidence: Math.max(old.confidence, input.confidence ?? old.confidence),
    category: old.category ?? input.category,
    updated: now,
    usedCount: old.usedCount + 1,
    evidence: old.evidence + 1,
    provenance: [...old.provenance, `merge:${input.source?.harness ?? "unknown"}:${new Date(now).toISOString()}`],
    source: { ...old.source },
    links: [...new Set([...old.links, ...(input.links ?? [])])],
  };
}

/** Adapt a stored record back into a WriteInput for dedupe comparison. */
function writeInputFromRecord(record: MemoryRecord): WriteInput {
  return {
    type: record.type,
    category: record.category,
    scope: record.scope,
    project: record.project,
    title: record.title,
    description: record.description,
    content: record.content,
    tags: record.tags,
    entities: record.entities,
    importance: record.importance,
    confidence: record.confidence,
    pinned: record.pinned,
    links: record.links,
    supersedes: record.supersedes,
    sensitive: record.sensitive,
    source: record.source,
  };
}

function pickFresherBody(old: MemoryRecord, input: WriteInput): string {
  const oldBody = old.content.trim();
  const newBody = (input.content ?? "").trim();
  if (!newBody) return oldBody;
  if (oldBody.includes(newBody)) return oldBody;
  if (newBody.includes(oldBody)) return newBody;
  return `${oldBody}\n\n<!-- merged ${dayKey()} -->\n${newBody}`;
}

/** Apply a supersede transition to the old record. */
export function supersedeOld(old: MemoryRecord, newId: string, now: number): MemoryRecord {
  return {
    ...old,
    status: "superseded",
    validTo: now,
    supersededBy: newId,
    updated: now,
  };
}
