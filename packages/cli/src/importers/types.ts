/** Shared types and helpers for the migration importers. */

import { createHash } from "node:crypto";

import type { HarnessId, ImportRecord, MemoryScope, MemoryType } from "@harnmem/core";

import type { ProjectInfo } from "../identity.js";

export interface ImportItem {
  /** Idempotency key: `<harness>|<relative origin path>|<originalId>`. */
  key: string;
  /** SHA-256 of the canonical source record. */
  sourceHash: string;
  /** Absolute source file. */
  originPath: string;
  record: ImportRecord;
  note?: string;
}

export interface UnresolvedGroup {
  /** Legacy project key (dir name, session hash, …). */
  key: string;
  reason: string;
  originPaths: string[];
  records: ImportRecord[];
}

export interface DiscoverCounts {
  files: number;
  entries: number;
  skipped: number;
  dailyEntries?: number;
}

export interface DiscoverResult {
  harness: HarnessId | "json";
  sourceRoot: string;
  items: ImportItem[];
  unresolved: UnresolvedGroup[];
  counts: DiscoverCounts;
  warnings: string[];
}

export interface DiscoverOptions {
  /** Directory/file the user pointed at (`--path`, or a harness default). */
  sourcePath: string;
  /** Display/idempotency label when `sourcePath` is a materialized stdin file (`-`). */
  sourceLabel?: string;
  /** Legacy session-log root used for cwd recovery; undefined disables it. */
  sessionsRoot?: string;
  /** Explicit legacy-key → projectId|path overrides from `--path-map`. */
  pathMap: Record<string, string>;
  /** Fallback project for records that cannot be attributed (never the user scope). */
  fallbackProject?: ProjectInfo;
  /** Explicit project resolution for `<home>/memories` (git/path detection). */
  cwd: string;
  home: string;
  /** Import pi daily notes (default true). */
  includeDaily: boolean;
  /** JSON source: force JSONL parsing even when the file is named `.json`. */
  jsonl?: boolean;
  /** Markdown source: `file` (default) or `heading` splitting. */
  mdMode?: "file" | "heading";
  /** Markdown source: hard file cap (default 5000). */
  maxFiles?: number;
  /** Markdown source: include host instruction files / memory indexes. */
  includeAll?: boolean;
}

export const MAX_CONTENT_CHARS = 60_000;
export const MAX_TITLE_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 200;

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable JSON: sorted keys, so hashes do not change with property order. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = walk(obj[key]);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function hashRecord(record: ImportRecord): string {
  const { source: _source, ...rest } = record;
  return sha256Hex(canonicalJson(rest));
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function stripMarkdownDecorations(text: string): string {
  return text
    .replace(/^#+\s*/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^[\s>*\-+]+/, "")
    .trim();
}

/**
 * `#tag #another` → ["tag", "another"]. A tag must start the text or follow
 * whitespace / punctuation, so URL fragments (`docs#top`) and headings (`##`)
 * are not mistaken for tags.
 */
export function extractHashtags(text: string): string[] {
  const out: string[] = [];
  const re = /(^|[\s[{(（【<>，。、；：:!?！？])#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;
  for (const match of text.matchAll(re)) {
    const tag = match[2];
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** Wiki links `[[target]]` / `[[target|label]]` → targets. */
export function extractWikiLinks(text: string): string[] {
  const out: string[] = [];
  const re = /\[\[([^\][|]+)(?:\|[^\]]*)?\]\]/g;
  for (const match of text.matchAll(re)) {
    const target = (match[1] ?? "").trim();
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

const VALID_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export function asMemoryType(value: unknown, fallback: MemoryType = "reference"): MemoryType {
  return typeof value === "string" && (VALID_TYPES as readonly string[]).includes(value)
    ? (value as MemoryType)
    : fallback;
}

/** Legacy tag → unified type, first match wins in this order. */
export function typeFromLegacyTags(tags: string[]): MemoryType | undefined {
  const lower = tags.map((t) => t.toLowerCase());
  const has = (...names: string[]): boolean => names.some((name) => lower.includes(name));
  if (has("decision", "决策")) return "project";
  if (has("rule", "preference", "workflow", "规则", "偏好", "红线", "p0")) return "feedback";
  if (has("project", "项目")) return "project";
  if (has("lesson", "pitfall", "tooling", "教训", "坑", "工具")) return "reference";
  if (has("user", "用户")) return "user";
  if (has("reference", "资料")) return "reference";
  return undefined;
}

/**
 * Single declared type value → unified type. Accepts the four canonical names
 * plus the vocabulary legacy stores use in frontmatter (`decision`, `rule`,
 * `preference`, `lesson`, `pitfall`, `adr`, …); unknown words are ignored so
 * callers can fall back to tag/path inference.
 */
const DECLARED_TYPES: Record<string, MemoryType> = {
  user: "user",
  profile: "user",
  用户: "user",
  feedback: "feedback",
  rule: "feedback",
  rules: "feedback",
  preference: "feedback",
  preferences: "feedback",
  workflow: "feedback",
  workflows: "feedback",
  convention: "feedback",
  conventions: "feedback",
  policy: "feedback",
  policies: "feedback",
  guideline: "feedback",
  guidelines: "feedback",
  规则: "feedback",
  偏好: "feedback",
  红线: "feedback",
  p0: "feedback",
  project: "project",
  projects: "project",
  decision: "project",
  decisions: "project",
  adr: "project",
  rfc: "project",
  rfcs: "project",
  项目: "project",
  决策: "project",
  reference: "reference",
  lesson: "reference",
  lessons: "reference",
  pitfall: "reference",
  pitfalls: "reference",
  tooling: "reference",
  troubleshoot: "reference",
  troubleshooting: "reference",
  note: "reference",
  notes: "reference",
  教训: "reference",
  坑: "reference",
  工具: "reference",
  资料: "reference",
};

export function declaredType(value: unknown): MemoryType | undefined {
  if (typeof value !== "string") return undefined;
  return DECLARED_TYPES[value.trim().toLowerCase()];
}

/** String list from an array of strings or a comma/semicolon-separated string. */
export function asStringArray(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    for (const part of item.split(/[,;]/)) {
      const text = part.trim().replace(/^#+/, "").trim();
      if (text) out.push(text);
    }
  }
  return [...new Set(out)];
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Loose boolean for legacy stores (`true`, `"yes"`, `1`, `"on"`). */
export function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "yes", "y", "1", "on", "starred", "pinned"].includes(text)) return true;
    if (["false", "no", "n", "0", "off"].includes(text)) return false;
  }
  return undefined;
}

/** First Markdown heading (outside fenced code blocks), decorations stripped. */
export function firstHeading(text: string): string | undefined {
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const title = collapseWhitespace(stripMarkdownDecorations(match[1] ?? ""));
    if (title) return title;
  }
  return undefined;
}

/** First prose line (no headings, fences, tables, quotes, rules). */
export function firstProseLine(text: string): string | undefined {
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) continue;
    if (/^[|>]/.test(trimmed)) continue;
    if (/^([-*_]\s*){3,}$/.test(trimmed)) continue;
    const prose = collapseWhitespace(stripMarkdownDecorations(trimmed));
    if (prose) return prose;
  }
  return undefined;
}

/** `2026-10-25-deploy-notes.md` → `deploy notes` (title fallback for file names). */
export function humanizeStem(stem: string): string {
  const cleaned = stem
    .replace(/\.(md|mdx|mdc|markdown|txt)$/i, "")
    .replace(/^\d{4}[-_]?\d{2}[-_]?\d{2}[-_]?/, "")
    .replace(/^\d+[-_ ]+/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "untitled";
}

/**
 * Parse the timestamp formats legacy stores use: epoch ms/seconds, ISO 8601,
 * `YYYY-MM-DD HH:mm:ss`, `YYYY-MM-DD`, and numeric strings.
 * Date-only and naive datetimes are interpreted in the host's local zone
 * (the legacy stores wrote local wall-clock times).
 */
export function parseLegacyTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? Math.round(value * 1000) : value;
  }
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n < 1e12 ? Math.round(n * 1000) : n;
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  }
  const naive = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (naive) {
    const [, y, mo, d, h, mi, s] = naive;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0")).getTime();
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function asScope(value: unknown, fallback: MemoryScope): MemoryScope {
  return value === "user" || value === "project" ? value : fallback;
}

export function safeFileStem(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "entry";
}

/** Idempotency key builder shared by every importer. */
export function makeKey(harness: string, relativePath: string, originalId: string): string {
  return `${harness}|${relativePath.replace(/\\/g, "/")}|${originalId}`;
}

export function rememberType(record: ImportRecord): string {
  return record.type ?? "reference";
}
