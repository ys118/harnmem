/**
 * JSON source: an `ImportRecord[]` (or `{ records: [...] }`) file, as produced
 * by `harnmem import --from json` backups/exports. This is the lossless
 * round-trip path: explicit ids, timestamps, scope, project, provenance and
 * source are preserved verbatim; only missing required fields are normalized.
 */

import { readFile } from "node:fs/promises";

import type { ImportRecord, MemoryScope } from "@harnmem/core";

import { PROJECT_ID_RE } from "../identity.js";
import {
  MAX_CONTENT_CHARS,
  asMemoryType,
  asScope,
  canonicalJson,
  hashRecord,
  makeKey,
  parseLegacyTimestamp,
  truncate,
  type DiscoverOptions,
  type DiscoverResult,
  type ImportItem,
  type UnresolvedGroup,
} from "./types.js";

export function parseJsonRecords(raw: string, file: string): ImportRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { records?: unknown }).records;
  if (!Array.isArray(list)) {
    throw new Error(`invalid JSON import file ${file}: expected an array of records or {"records": [...]}`);
  }
  return list.map((value, index) => normalizeRecord(value, file, index));
}

function normalizeRecord(value: unknown, file: string, index: number): ImportRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${file}: record #${index} is not an object`);
  }
  const input = value as Partial<ImportRecord> & Record<string, unknown>;
  if (typeof input.type !== "string" || !["user", "feedback", "project", "reference"].includes(input.type)) {
    throw new Error(`${file}: record #${index} has invalid "type" (expected user|feedback|project|reference)`);
  }
  if (typeof input.title !== "string" || input.title.trim() === "") {
    throw new Error(`${file}: record #${index} is missing "title"`);
  }
  const type = asMemoryType(input.type);
  const scope: MemoryScope = asScope(input.scope, type === "user" ? "user" : "project");
  const created = parseLegacyTimestamp(input.created);
  const updated = parseLegacyTimestamp(input.updated) ?? created;
  return {
    ...input,
    id: typeof input.id === "string" && input.id.startsWith("mem_") ? input.id : undefined,
    type,
    title: truncate(input.title.trim(), 80),
    description: truncate(typeof input.description === "string" ? input.description : "", 200),
    content: truncate(typeof input.content === "string" ? input.content : "", MAX_CONTENT_CHARS),
    scope,
    project: scope === "project" && typeof input.project === "string" ? input.project : undefined,
    tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === "string") : [],
    entities: Array.isArray(input.entities) ? input.entities.filter((t): t is string => typeof t === "string") : [],
    importance: typeof input.importance === "number" ? input.importance : undefined,
    pinned: input.pinned === true,
    created,
    updated,
    lastUsed: parseLegacyTimestamp(input.lastUsed),
    usedCount: typeof input.usedCount === "number" ? input.usedCount : undefined,
    links: Array.isArray(input.links) ? input.links.filter((t): t is string => typeof t === "string") : [],
    source: {
      ...(typeof input.source === "object" && input.source ? input.source : {}),
      harness: typeof input.source?.harness === "string" ? input.source.harness : "json",
      ts: input.source?.ts ?? created ?? Date.now(),
      migratedFrom:
        input.source?.migratedFrom ?? {
          system: "harnmem-json",
          path: file,
          originalId: input.id ?? `idx-${index}`,
        },
    },
    provenance:
      Array.isArray(input.provenance) && input.provenance.length > 0
        ? input.provenance.filter((p): p is string => typeof p === "string")
        : [`json:${file}`],
    extra: input.extra,
  };
}

export async function discoverJson(options: DiscoverOptions): Promise<DiscoverResult> {
  const file = options.sourcePath;
  const warnings: string[] = [];
  const items: ImportItem[] = [];
  const unresolved: UnresolvedGroup[] = [];
  const counts: DiscoverResult["counts"] = { files: 1, entries: 0, skipped: 0 };

  const raw = await readFile(file, "utf8");
  const records = parseJsonRecords(raw, file);
  counts.entries = records.length;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    let normalized: ImportRecord = record;
    // JSON is the only source that may carry arbitrary project ids.
    if (record.scope === "project") {
      if (record.project && PROJECT_ID_RE.test(record.project)) {
        normalized = record;
      } else if (options.fallbackProject) {
        normalized = { ...record, project: options.fallbackProject.id, projectName: options.fallbackProject.name };
        warnings.push(`record ${record.id ?? i} had missing/invalid project — attributed to --project ${options.fallbackProject.id}`);
      } else {
        unresolved.push({
          key: record.project ?? `record-${i}`,
          reason: `record ${record.id ?? i} has missing/invalid project id`,
          originPaths: [file],
          records: [record],
        });
        continue;
      }
    }
    const originalId = normalized.id ?? `idx-${i}`;
    const key = makeKey("json", file, originalId);
    items.push({ key, sourceHash: canonicalJson(normalized), originPath: file, record: normalized });
  }

  return { harness: "json", sourceRoot: file, items, unresolved, counts, warnings };
}

export { hashRecord };
