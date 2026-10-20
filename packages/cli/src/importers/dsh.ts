/**
 * DSH migration source: `<home>/.dsh/memory/`.
 *
 * Layout: per-project directories named after the encoded cwd
 * (`--D-projects-example-project--`), a `_user/` global directory, `MEMORY.md`
 * indexes, per-memory `<name>.md` files with YAML frontmatter, and an
 * `audit.jsonl` operation log (never imported; counts only).
 *
 * The entry files are the SSOT; MEMORY.md is only an index, so entries are
 * discovered from `*.md` files and MEMORY.md itself is not parsed for content.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, relative } from "node:path";

import type { ImportRecord } from "@harnmem/core";

import { parseFrontmatter, fmString, fmNumber, fmBoolean, fmArray, type FrontmatterValue } from "../frontmatter.js";
import { attributeProject } from "../project-resolve.js";
import { decodeLegacyDirName, readDshSessionCwds } from "../session-cwd.js";
import {
  MAX_CONTENT_CHARS,
  asMemoryType,
  extractHashtags,
  extractWikiLinks,
  hashRecord,
  makeKey,
  parseLegacyTimestamp,
  truncate,
  type DiscoverOptions,
  type DiscoverResult,
  type ImportItem,
  type UnresolvedGroup,
} from "./types.js";

const USER_DIRS = new Set(["_user", "user", "_global", "global"]);

/** One `- [title](file.md) 📌 — description` line from a DSH MEMORY.md index. */
interface DshIndexEntry {
  title?: string;
  description?: string;
  pinned: boolean;
}

/**
 * MEMORY.md is only an index, but it carries the exact display title and
 * description that dsh-auto-memory showed the model, and some entry files omit
 * `title:` from frontmatter. Parse it as a metadata overlay.
 */
async function readDshIndex(dirPath: string): Promise<Map<string, DshIndexEntry>> {
  const out = new Map<string, DshIndexEntry>();
  let raw: string;
  try {
    raw = await readFile(join(dirPath, "MEMORY.md"), "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    const match = /^-\s*\[([^\]]+)\]\(([^)]+\.md)\)\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const title = match[1]?.trim();
    const file = match[2]?.split("/").pop()?.trim();
    if (!title || !file) continue;
    let rest = (match[3] ?? "").trim();
    const pinned = rest.includes("📌");
    rest = rest
      .replace(/📌/g, "")
      .replace(/^[—–-]\s*/, "")
      .trim();
    out.set(file, { title, description: rest || undefined, pinned });
  }
  return out;
}

export async function discoverDsh(options: DiscoverOptions): Promise<DiscoverResult> {
  const memoryRoot = options.sourcePath;
  const warnings: string[] = [];
  const items: ImportItem[] = [];
  const unresolved: UnresolvedGroup[] = [];
  const counts: DiscoverResult["counts"] = { files: 0, entries: 0, skipped: 0 };

  let dirs: string[];
  try {
    const infos = await readdir(memoryRoot, { withFileTypes: true });
    dirs = infos.filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (err) {
    throw new Error(`DSH memory directory not readable: ${memoryRoot} (${(err as Error).message})`);
  }

  const cwds = options.sessionsRoot ? await readDshSessionCwds(options.sessionsRoot) : new Map();
  if (!options.sessionsRoot) warnings.push("no DSH session log root supplied: project dirs can only be attributed via --path-map or existing decoded paths");
  else if (cwds.size === 0) warnings.push(`no DSH session headers found under ${options.sessionsRoot}: project attribution falls back to --path-map / decoded paths`);

  for (const dir of dirs) {
    const dirPath = join(memoryRoot, dir);
    const files = (await readdir(dirPath)).filter((name) => name.endsWith(".md"));
    const entryFiles = files.filter((name) => name.toUpperCase() !== "MEMORY.MD").sort();
    const isUser = USER_DIRS.has(dir);
    const index = await readDshIndex(dirPath);

    if (entryFiles.length === 0) {
      counts.skipped += 1;
      warnings.push(`no entry .md files in ${dirPath} (MEMORY.md only) — skipped`);
      continue;
    }

    let project: Awaited<ReturnType<typeof attributeProject>> | undefined;
    if (!isUser) {
      const recovered = cwds.get(dir);
      const decoded = decodeLegacyDirName(dir) ?? undefined;
      project = await attributeProject({
        keys: [dir, dirPath],
        pathMap: options.pathMap,
        home: options.home,
        cwd: options.cwd,
        harness: "dsh",
        sessionCwd: recovered?.cwd,
        decodedPath: recovered?.cwd ? undefined : decoded,
        fallback: options.fallbackProject,
      });
      if (!project.project) {
        const group: UnresolvedGroup = {
          key: dir,
          reason: project.reason ?? "unknown project",
          originPaths: entryFiles.map((f) => join(dirPath, f)),
          records: [],
        };
        const created = await collectEntries(dirPath, dir, entryFiles, counts, warnings, index, group.records, isUser);
        items.push(...created);
        unresolved.push(group);
        continue;
      }
      if (project.guessed) warnings.push(`project dir ${dir} attributed by ${project.reason ?? "heuristic"} (verify before trusting)`);
    }

    const created = await collectEntries(
      dirPath,
      dir,
      entryFiles,
      counts,
      warnings,
      index,
      undefined,
      isUser,
      project?.project,
    );
    items.push(...created);
  }

  // audit.jsonl is an operation log, not memory content; report only.
  const auditPath = join(memoryRoot, "audit.jsonl");
  if (existsSync(auditPath)) {
    try {
      const raw = await readFile(auditPath, "utf8");
      const lines = raw.split("\n").filter((line) => line.trim() !== "").length;
      warnings.push(`audit.jsonl present (${lines} entries) — operation log, not imported`);
    } catch {
      // ignore
    }
  }

  return { harness: "dsh", sourceRoot: memoryRoot, items, unresolved, counts, warnings };
}

/** Parse one project/user directory into ImportItems (or unresolved records). */
async function collectEntries(
  dirPath: string,
  dirName: string,
  entryFiles: string[],
  counts: { files: number; entries: number; skipped: number },
  warnings: string[],
  index: Map<string, DshIndexEntry>,
  unresolvedRecords: ImportRecord[] | undefined,
  isUser: boolean,
  project?: { id: string; name: string },
): Promise<ImportItem[]> {
  const items: ImportItem[] = [];
  for (const file of entryFiles) {
    const absPath = join(dirPath, file);
    let raw: string;
    try {
      raw = await readFile(absPath, "utf8");
    } catch (err) {
      counts.skipped += 1;
      warnings.push(`unreadable file ${absPath}: ${(err as Error).message}`);
      continue;
    }
    counts.files += 1;
    const stem = basename(file, ".md");
    const parsed = parseFrontmatter(raw);
    const fm = parsed.data;
    const body = parsed.body;
    if (body.trim() === "") {
      counts.skipped += 1;
      warnings.push(`empty body in ${absPath} — skipped (index-only?)`);
      continue;
    }
    const created = parseLegacyTimestamp(fmString(fm, "created"));
    const updated = parseLegacyTimestamp(fmString(fm, "updated")) ?? created;
    const originalId = stem;
    const key = makeKey("dsh", relative(join(dirPath, ".."), absPath), originalId);
    const recordTags = fmArray(fm, "tags");
    const wikiLinks = extractWikiLinks(body);
    const hashtags = extractHashtags(firstNonEmptyLine(body));
    const scope = isUser ? "user" : ("project" as const);
    const indexEntry = index.get(file);
    const title = truncate(
      (fmString(fm, "title") ?? indexEntry?.title ?? stemTitle(stem)).trim() || stemTitle(stem),
      80,
    );
    const description = fmString(fm, "description") ?? indexEntry?.description ?? truncate(firstNonEmptyLine(body), 200);
    const record: ImportRecord = {
      id: undefined,
      type: asMemoryType(fmString(fm, "type"), isUser ? "user" : "reference"),
      title,
      description: truncate(description, 200),
      content: truncate(body, MAX_CONTENT_CHARS),
      scope,
      project: scope === "project" ? project?.id : undefined,
      projectName: scope === "project" ? project?.name : undefined,
      tags: recordTags.length > 0 ? recordTags : hashtags,
      entities: [],
      importance: fmNumber(fm, "importance"),
      confidence: undefined,
      pinned: fmBoolean(fm, "pinned") ?? indexEntry?.pinned ?? false,
      created,
      updated,
      lastUsed: parseLegacyTimestamp(fmString(fm, "lastRead")),
      usedCount: fmNumber(fm, "reads"),
      links: wikiLinks,
      source: {
        harness: "dsh",
        ts: created ?? Date.now(),
        migratedFrom: { system: "dsh-auto-memory", path: absPath, originalId },
      },
      provenance: [`dsh:${dirName}`, `file:${file}`],
      extra: {
        legacy: {
          harness: "dsh-auto-memory",
          dir: dirName,
          name: fmString(fm, "name") ?? stem,
          reads: fmNumber(fm, "reads") ?? 0,
          lastRead: parseLegacyTimestamp(fmString(fm, "lastRead")) ?? null,
          frontmatterKeys: Object.keys(fm).sort(),
        },
      },
    };
    if (unresolvedRecords) {
      unresolvedRecords.push(record);
      counts.entries += 1;
      continue;
    }
    items.push({ key, sourceHash: hashRecord(record), originPath: absPath, record });
    counts.entries += 1;
    if (body.length > MAX_CONTENT_CHARS) warnings.push(`content truncated to ${MAX_CONTENT_CHARS} chars: ${absPath}`);
  }
  return items;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

function stemTitle(stem: string): string {
  return stem.replace(/[-_]+/g, " ").trim() || "untitled";
}

export type { FrontmatterValue };
