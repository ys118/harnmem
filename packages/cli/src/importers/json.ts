/**
 * JSON source: any flat JSON/JSONL export mapped onto `ImportRecord`.
 *
 * Accepted inputs, in priority order:
 *  - `ImportRecord[]` or an envelope object (`records|memories|data|results|items`),
 *    the lossless round-trip path (`harnmem export`);
 *  - JSONL/NDJSON (`.jsonl`/`.ndjson`, `--jsonl`, or auto-detected when the whole
 *    file is not valid JSON);
 *  - permissive record objects: field aliases (`name` 鈫?title, `text` 鈫?content, 鈥?,
 *    `metadata.*` overlays, type/scope/title inference, `0..1` relevance scores.
 *
 * One malformed record is collected into the unresolved bucket; it never aborts
 * the file. `counts.errors` stays reserved for persistence failures.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { ImportRecord, MemoryScope, MemoryStatus, MemoryType } from "@harnmem/core";
import { UsageError } from "../args.js";

import { PROJECT_ID_RE } from "../identity.js";
import {
  MAX_CONTENT_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_TITLE_CHARS,
  asBoolean,
  asNumber,
  asStringArray,
  collapseWhitespace,
  declaredType,
  extractHashtags,
  firstHeading,
  firstProseLine,
  hashRecord,
  humanizeStem,
  makeKey,
  parseLegacyTimestamp,
  truncate,
  typeFromLegacyTags,
  type DiscoverOptions,
  type DiscoverResult,
  type ImportItem,
  type UnresolvedGroup,
} from "./types.js";

export interface ParseJsonOptions {
  /** Force line-delimited parsing (also triggered by `.jsonl`/`.ndjson`). */
  jsonl?: boolean;
}

/** One decoded top-level entry, before field normalization. */
interface RawEntry {
  index: number;
  value: unknown;
}

interface Normalized {
  record?: ImportRecord;
  reason?: string;
  warnings: string[];
}

const ENVELOPE_KEYS = ["records", "memories", "data", "results", "items"] as const;
const MEMORY_STATUSES: readonly MemoryStatus[] = ["active", "superseded", "archived", "dropped"];

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

function tryParseJson(text: string): { value?: unknown; error?: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function extractEnvelope(value: unknown): RawEntry[] | { error: string } {
  if (Array.isArray(value)) return value.map((entry, index) => ({ index, value: entry }));
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    for (const key of ENVELOPE_KEYS) {
      const list = object[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) return { error: `"${key}" must be an array of records` };
      return list.map((entry, index) => ({ index, value: entry }));
    }
    const keys = Object.keys(object).slice(0, 8).join(", ");
    return { error: `expected an array of records or one of {${ENVELOPE_KEYS.join("|")}}; found keys: ${keys}` };
  }
  return { error: `expected an array of records or an envelope object, got ${value === null ? "null" : typeof value}` };
}

function parseJsonLines(text: string): RawEntry[] | { error: string } {
  const entries: RawEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = (lines[lineNo] ?? "").trim();
    if (line === "" || line.startsWith("//")) continue;
    const parsed = tryParseJson(line);
    if (parsed.error !== undefined) return { error: `line ${lineNo + 1}: ${parsed.error}` };
    entries.push({ index: entries.length, value: parsed.value });
  }
  return entries;
}

function looksLikeJsonl(file: string, options: ParseJsonOptions): boolean {
  return options.jsonl === true || /\.(jsonl|ndjson)$/i.test(file);
}

/**
 * Decode any accepted input into raw entries. Throws only when the file itself
 * cannot be decoded 鈥?record-level problems are handled by `normalizeRecord`.
 */
export function decodeJsonInput(raw: string, file: string, options: ParseJsonOptions = {}): RawEntry[] {
  const text = stripBom(raw).trim();
  if (text === "") throw new UsageError(`invalid JSON import file ${file}: file is empty`);
  if (!looksLikeJsonl(file, options)) {
    const parsed = tryParseJson(text);
    if (parsed.error === undefined) {
      const envelope = extractEnvelope(parsed.value);
      if (Array.isArray(envelope)) return envelope;
      throw new UsageError(`invalid JSON import file ${file}: ${envelope.error}`);
    }
    // Not a single JSON document: accept JSONL when every line decodes.
    const lines = parseJsonLines(text);
    if (Array.isArray(lines)) {
      if (lines.length === 0) throw new UsageError(`invalid JSON import file ${file}: ${parsed.error}`);
      return lines;
    }
    throw new UsageError(`invalid JSON in ${file}: ${parsed.error}`);
  }
  const lines = parseJsonLines(text);
  if (Array.isArray(lines)) return lines;
  throw new UsageError(`invalid JSONL in ${file}: ${lines.error}`);
}

function metadataOf(input: Record<string, unknown>): Record<string, unknown> {
  const meta = input.metadata;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

interface Picked {
  key: string;
  /** Alias without the `metadata.` prefix. */
  name: string;
  value: unknown;
}

/** First present alias: top level first, then `metadata.*`. */
function pick(input: Record<string, unknown>, meta: Record<string, unknown>, keys: string[]): Picked | undefined {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null) return { key, name: key, value };
  }
  for (const key of keys) {
    const value = meta[key];
    if (value !== undefined && value !== null) return { key: `metadata.${key}`, name: key, value };
  }
  return undefined;
}

function stringOf(picked: Picked | undefined): string | undefined {
  return typeof picked?.value === "string" && picked.value.trim() !== "" ? picked.value : undefined;
}

function contentOf(picked: Picked | undefined): string {
  if (!picked) return "";
  const value = picked.value;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function timestampOf(input: Record<string, unknown>, meta: Record<string, unknown>, keys: string[]): number | undefined {
  return parseLegacyTimestamp(pick(input, meta, keys)?.value);
}

function linksOf(input: Record<string, unknown>, meta: Record<string, unknown>, keys: string[]): string[] {
  return asStringArray(pick(input, meta, keys)?.value);
}

const SCORE_LIKE = new Set(["score", "relevance", "salience", "weight"]);

function importanceOf(picked: Picked | undefined): number | undefined {
  if (!picked) return undefined;
  let value = asNumber(picked.value);
  if (value === undefined) return undefined;
  if (SCORE_LIKE.has(picked.name) && value > 0 && value <= 1) value *= 10;
  return Math.max(0, Math.min(10, Math.round(value)));
}

function confidenceOf(picked: Picked | undefined): number | undefined {
  const value = asNumber(picked?.value);
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(1, value));
}

/**
 * Map one permissive object onto `ImportRecord`. Returns `{reason}` when nothing
 * importable can be derived (the discovery layer reports it as unresolved).
 */
function normalizeRecord(value: unknown, file: string, index: number): Normalized {
  const warnings: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "not an object", warnings };
  }
  const input = value as Record<string, unknown>;
  const meta = metadataOf(input);

  const contentPick = pick(input, meta, ["content", "text", "memory", "body", "note", "value"]);
  let content = contentOf(contentPick);
  if (content.length > MAX_CONTENT_CHARS) {
    content = truncate(content, MAX_CONTENT_CHARS);
    warnings.push(`${file}: record #${index} content truncated to ${MAX_CONTENT_CHARS} characters`);
  }

  const tagList = asStringArray(pick(input, meta, ["tags", "keywords", "labels", "categories"])?.value);
  const hashtags = extractHashtags(content);
  const tags = [...new Set([...tagList, ...hashtags])].slice(0, 64);

  const declared = declaredType(pick(input, meta, ["type", "memory_type", "kind"])?.value);
  const explicitScopeRaw = pick(input, meta, ["scope", "level"])?.value;
  const explicitScope: MemoryScope | undefined =
    explicitScopeRaw === "user" || explicitScopeRaw === "project" ? explicitScopeRaw : undefined;
  const type: MemoryType =
    declared ?? typeFromLegacyTags(tags) ?? (explicitScope === "user" ? "user" : "reference");
  const scope: MemoryScope = explicitScope ?? (type === "user" ? "user" : "project");

  let title = stringOf(pick(input, meta, ["title", "name", "subject", "heading", "label"])) ?? "";
  title = truncate(collapseWhitespace(title), MAX_TITLE_CHARS);
  let titleFromProse = false;
  if (title === "") {
    const derived = firstHeading(content) ?? firstProseLine(content) ?? humanizeStem(basename(file));
    if (derived) {
      title = truncate(derived, MAX_TITLE_CHARS);
      titleFromProse = firstHeading(content) === undefined;
    }
  }
  if (title === "") return { reason: "missing title and content", warnings };

  let description = (stringOf(pick(input, meta, ["description", "summary", "desc", "abstract"])) ?? "").trim();
  if (description === "" && !titleFromProse) description = firstProseLine(content) ?? "";
  description = truncate(collapseWhitespace(description), MAX_DESCRIPTION_CHARS);

  const idPick = pick(input, meta, ["id", "uuid", "uid", "memory_id"]);
  const idString = typeof idPick?.value === "string" && idPick.value.trim() !== "" ? idPick.value.trim() : undefined;
  const originalId = idString ?? `idx-${index}`;
  const id = idString && idString.startsWith("mem_") ? idString : undefined;

  const projectRaw = stringOf(pick(input, meta, ["project", "project_id", "projectId"]));
  const project = scope === "project" ? projectRaw : undefined;

  const created = timestampOf(input, meta, ["created", "created_at", "createdAt", "create_time", "date", "timestamp", "ts"]);
  const updated =
    timestampOf(input, meta, ["updated", "updated_at", "updatedAt", "modified", "last_modified", "mtime"]) ?? created;
  const statusPick = pick(input, meta, ["status", "state"]);
  const status =
    typeof statusPick?.value === "string" && (MEMORY_STATUSES as readonly string[]).includes(statusPick.value)
      ? statusPick.value as MemoryStatus
      : undefined;

  const sourceInput =
    input.source && typeof input.source === "object" && !Array.isArray(input.source)
      ? (input.source as Partial<ImportRecord["source"]>)
      : undefined;
  const logicalPath = file;
  const provenanceInput = asStringArray(input.provenance);

  return {
    warnings,
    record: {
      id,
      type,
      title,
      description,
      content,
      category: typeof pick(input, meta, ["category", "topic", "domain", "area"])?.value === "string"
        ? (pick(input, meta, ["category", "topic", "domain", "area"])?.value as ImportRecord["category"])
        : undefined,
      scope,
      project: scope === "project" ? project : undefined,
      projectName: typeof input.projectName === "string" ? input.projectName : undefined,
      tags,
      entities: linksOf(input, meta, ["entities", "people", "subjects"]),
      importance: importanceOf(pick(input, meta, ["importance", "weight", "priority", "salience", "relevance", "score"])),
      confidence: confidenceOf(pick(input, meta, ["confidence", "certainty"])),
      pinned: asBoolean(pick(input, meta, ["pinned", "pin", "starred", "favorite"])?.value) ?? false,
      status,
      created,
      updated,
      lastUsed: timestampOf(input, meta, ["last_used", "lastUsed", "lastUsedAt", "accessed_at", "accessed"]),
      usedCount: asNumber(pick(input, meta, ["used_count", "usedCount", "access_count"])?.value),
      validFrom: timestampOf(input, meta, ["valid_from", "validFrom"]),
      validTo: pick(input, meta, ["valid_to", "validTo"])?.value === null ? null : timestampOf(input, meta, ["valid_to", "validTo"]),
      observedAt: timestampOf(input, meta, ["observed_at", "observedAt"]),
      evidence: asNumber(pick(input, meta, ["evidence"])?.value),
      source: {
        ...(sourceInput ?? {}),
        harness: typeof sourceInput?.harness === "string" ? sourceInput.harness : "json",
        ts: sourceInput?.ts ?? created ?? Date.now(),
        migratedFrom: sourceInput?.migratedFrom ?? {
          system: "harnmem-json",
          path: logicalPath,
          originalId,
        },
      },
      provenance: provenanceInput.length > 0 && input.provenance !== undefined ? provenanceInput : [`json:${logicalPath}`],
      links: linksOf(input, meta, ["links", "related", "relations", "references", "refs", "see_also"]),
      supersedes: linksOf(input, meta, ["supersedes", "replaces"]),
      supersededBy: typeof input.supersededBy === "string" ? input.supersededBy : input.supersededBy === null ? null : undefined,
      sensitive: asBoolean(pick(input, meta, ["sensitive", "private", "secret"])?.value),
      extra:
        input.extra && typeof input.extra === "object" && !Array.isArray(input.extra)
          ? (input.extra as Record<string, unknown>)
          : undefined,
    },
  };
}

/** Invalid raw entries are kept in the unresolved bucket for inspection. */
function invalidPlaceholder(value: unknown, index: number, reason: string): ImportRecord {
  let rendered = "";
  try {
    rendered = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    rendered = String(value);
  }
  return {
    type: "reference",
    title: `invalid record #${index}`,
    description: truncate(reason, MAX_DESCRIPTION_CHARS),
    content: truncate(rendered, MAX_CONTENT_CHARS),
    scope: "user",
  };
}

export async function discoverJson(options: DiscoverOptions): Promise<DiscoverResult> {
  const file = options.sourcePath;
  const logicalPath = options.sourceLabel ?? file;
  const warnings: string[] = [];
  const items: ImportItem[] = [];
  const unresolved: UnresolvedGroup[] = [];
  const counts: DiscoverResult["counts"] = { files: 1, entries: 0, skipped: 0 };

  const raw = await readFile(file, "utf8");
  const entries = decodeJsonInput(raw, file, { jsonl: options.jsonl });
  counts.entries = entries.length;

  const invalid: ImportRecord[] = [];
  const unattributed: ImportRecord[] = [];
  const invalidProjectIds = new Set<string>();
  let fallbackAttributed = 0;
  for (const entry of entries) {
    const normalized = normalizeRecord(entry.value, logicalPath, entry.index);
    warnings.push(...normalized.warnings);
    if (!normalized.record) {
      invalid.push(invalidPlaceholder(entry.value, entry.index, normalized.reason ?? "invalid record"));
      continue;
    }
    let normalizedRecord: ImportRecord = normalized.record;
    // JSON is the only source that may carry arbitrary project ids.
    if (normalizedRecord.scope === "project") {
      if (normalizedRecord.project && PROJECT_ID_RE.test(normalizedRecord.project)) {
        // trusted id
      } else if (options.fallbackProject) {
        if (normalizedRecord.project) invalidProjectIds.add(normalizedRecord.project);
        normalizedRecord = {
          ...normalizedRecord,
          project: options.fallbackProject.id,
          projectName: options.fallbackProject.name,
        };
        fallbackAttributed += 1;
      } else {
        unattributed.push(normalizedRecord);
        continue;
      }
    }
    const originalId =
      normalizedRecord.source?.migratedFrom?.originalId ?? normalizedRecord.id ?? `idx-${entry.index}`;
    const key = makeKey("json", logicalPath, originalId);
    items.push({ key, sourceHash: hashRecord(normalizedRecord), originPath: file, record: normalizedRecord });
  }

  if (fallbackAttributed > 0) {
    warnings.push(
      `${fallbackAttributed} project-scoped record(s) had no project id 鈥?attributed to --project ${
        options.fallbackProject?.id ?? "?"
      }`,
    );
  }
  if (invalidProjectIds.size > 0) {
    warnings.push(
      `ignored invalid project id(s) (expected <slug>-<10 hex>): ${[...invalidProjectIds].slice(0, 5).join(", ")}`,
    );
  }
  if (unattributed.length > 0) {
    unresolved.push({
      key: `no-project:${basename(logicalPath) || "json"}`,
      reason:
        "records are project-scoped but no valid project id was found; pass --project <path|id> " +
        '(or set "scope": "user" on these records) and re-run',
      originPaths: [file],
      records: unattributed,
    });
    warnings.push(
      `${unattributed.length} record(s) in ${logicalPath} have no project; pass --project <path|id> to attribute them`,
    );
  }
  if (invalid.length > 0) {
    const key = `invalid:${basename(logicalPath) || "json"}`;
    unresolved.push({
      key,
      reason: `${invalid.length} record(s) could not be normalized; fix the export or convert them by hand`,
      originPaths: [file],
      records: invalid,
    });
    warnings.push(`${invalid.length} record(s) in ${logicalPath} could not be normalized (see \`harnmem import unresolved\`)`);
  }
  if (entries.length === 0) warnings.push(`${logicalPath} contained no records`);

  return { harness: "json", sourceRoot: file, items, unresolved, counts, warnings };
}

export { hashRecord };

