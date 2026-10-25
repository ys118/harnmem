/**
 * Claude Code migration source.
 *
 * Layout (from the dsh-auto-memory migration notes, see
 * `docs/research/dsh-plugin-and-migration.md` §Claude Code):
 *
 *   `<root>/projects/<slug>/`
 *     ├── MEMORY.md          (index: display title / description overlay)
 *     ├── <topic>.md         (frontmatter: name, description, metadata.type, …)
 *     ├── memory/<topic>.md
 *     └── <session>.jsonl    (session log; the head carries the real `cwd`)
 *   `<root>/memory/*.md`     (legacy tree; user scope by definition)
 *
 * The project slug is a lossy encoding of the cwd, so attribution needs
 * `--path-map`, the cwd recovered from a session log, or an explicit `--project`
 * fallback. Unresolved records go to the unresolved bucket — never silently to
 * the user scope. `MEMORY.md` is an index only and is never imported.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import type { ImportRecord, MemoryScope } from "@harnmem/core";

import { fmNestedString, fmNumber, fmString, parseFrontmatter } from "../frontmatter.js";
import { attributeProject } from "../project-resolve.js";
import { readClaudeSessionCwds } from "../session-cwd.js";
import {
  MAX_CONTENT_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_TITLE_CHARS,
  collapseWhitespace,
  declaredType,
  extractHashtags,
  extractWikiLinks,
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

/** One `- [title](file.md) — description` line from a Claude Code MEMORY.md index. */
interface ClaudeIndexEntry {
  title?: string;
  description?: string;
  pinned: boolean;
}

interface ReadRecordOptions {
  root: string;
  absPath: string;
  scope: MemoryScope;
  project?: string;
  projectName?: string;
  overlay?: ClaudeIndexEntry;
  tree: string;
}

export async function discoverClaude(options: DiscoverOptions): Promise<DiscoverResult> {
  const root = options.sourcePath;
  const projectsRoot = join(root, "projects");
  const legacyRoot = join(root, "memory");
  const hasProjects = existsSync(projectsRoot);
  const hasLegacy = existsSync(legacyRoot);
  const warnings: string[] = [];
  const items: ImportItem[] = [];
  const unresolved: UnresolvedGroup[] = [];
  const counts: DiscoverResult["counts"] = { files: 0, entries: 0, skipped: 0 };

  if (!hasProjects && !hasLegacy) {
    warnings.push(`Claude Code memory data not found at ${root} (nothing to import; skipped gracefully)`);
    return { harness: "claude", sourceRoot: root, items, unresolved, counts, warnings };
  }

  if (hasProjects) {
    const cwds = await readClaudeSessionCwds(projectsRoot);
    let slugs: string[] = [];
    try {
      slugs = (await readdir(projectsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      slugs = [];
    }
    for (const slug of slugs) {
      const dirPath = join(projectsRoot, slug);
      const files = await collectProjectFiles(dirPath);
      if (files.length === 0) {
        counts.skipped += 1;
        continue;
      }
      const attribution = await attributeProject({
        keys: [slug, dirPath],
        pathMap: options.pathMap,
        home: options.home,
        cwd: options.cwd,
        harness: "claude",
        sessionCwd: cwds.get(slug)?.cwd,
        fallback: options.fallbackProject,
      });
      const index = await readIndexOverlay(dirPath);
      const records: ImportRecord[] = [];
      for (const absPath of files) {
        const record = await readRecord({
          root,
          absPath,
          scope: "project",
          project: attribution.project?.id,
          projectName: attribution.project?.name,
          overlay: index.get(basename(absPath)),
          tree: `projects/${slug}`,
        });
        if (!record) {
          counts.skipped += 1;
          warnings.push(`empty or unreadable Claude Code memory ${absPath}`);
          continue;
        }
        counts.files += 1;
        counts.entries += 1;
        if (!attribution.project) {
          records.push(record);
          continue;
        }
        items.push({ key: makeKey("claude", relPath(root, absPath), basename(absPath, ".md")), sourceHash: hashRecord(record), originPath: absPath, record });
      }
      if (records.length > 0) {
        unresolved.push({
          key: slug,
          reason: attribution.reason ?? "unknown Claude Code project",
          originPaths: records.map((record) => record.source?.migratedFrom?.path ?? dirPath),
          records,
        });
      }
    }
  }

  if (hasLegacy) {
    let names: string[] = [];
    try {
      names = (await readdir(legacyRoot))
        .filter((name) => name.toLowerCase().endsWith(".md") && name.toUpperCase() !== "MEMORY.MD")
        .sort();
    } catch {
      names = [];
    }
    const index = await readIndexOverlay(legacyRoot);
    for (const name of names) {
      const absPath = join(legacyRoot, name);
      const record = await readRecord({
        root,
        absPath,
        scope: "user",
        overlay: index.get(name),
        tree: "memory",
      });
      if (!record) {
        counts.skipped += 1;
        warnings.push(`empty or unreadable Claude Code memory ${absPath}`);
        continue;
      }
      counts.files += 1;
      counts.entries += 1;
      items.push({ key: makeKey("claude", relPath(root, absPath), basename(name, ".md")), sourceHash: hashRecord(record), originPath: absPath, record });
    }
  }

  if (items.length === 0 && unresolved.length === 0) {
    warnings.push(`no importable Claude Code memory records found under ${root}`);
  }
  return { harness: "claude", sourceRoot: root, items, unresolved, counts, warnings };
}

/** `*.md` directly under a project dir and under its `memory/` subdir; index files excluded. */
async function collectProjectFiles(dirPath: string): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (absPath: string): void => {
    if (seen.has(absPath)) return;
    seen.add(absPath);
    out.push(absPath);
  };
  for (const dir of [dirPath, join(dirPath, "memory")]) {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      if (name.toUpperCase() === "MEMORY.MD") continue;
      add(join(dir, name));
    }
  }
  return out.sort();
}

/** MEMORY.md carries the display title / description; parse it as an overlay only. */
async function readIndexOverlay(dirPath: string): Promise<Map<string, ClaudeIndexEntry>> {
  const out = new Map<string, ClaudeIndexEntry>();
  for (const name of ["MEMORY.md", join("memory", "MEMORY.md")]) {
    let raw: string;
    try {
      raw = await readFile(join(dirPath, name), "utf8");
    } catch {
      continue;
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
  }
  return out;
}

async function readRecord(options: ReadRecordOptions): Promise<ImportRecord | undefined> {
  let raw: string;
  let mtime: number;
  try {
    raw = await readFile(options.absPath, "utf8");
    mtime = (await stat(options.absPath)).mtimeMs;
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(raw);
  if (parsed.body.trim() === "") return undefined;
  const data = parsed.data;
  const meta = (data.metadata ?? {}) as Record<string, unknown>;
  const stem = basename(options.absPath, ".md");
  const legacyType = fmString(data, "type") ?? fmNestedString(data, raw, "metadata", "type");
  const tags = dedupe([
    ...stringList(data, "tags"),
    ...stringList(data, "keywords"),
    ...stringList(data, "categories"),
    ...extractHashtags(parsed.body),
  ]);
  const title = truncate(
    firstNonEmpty(fmString(data, "name"), fmString(data, "title"), options.overlay?.title, firstHeading(parsed.body), humanizeStem(stem)) ??
      humanizeStem(stem),
    MAX_TITLE_CHARS,
  );
  const description = truncate(
    collapseWhitespace(
      firstNonEmpty(fmString(data, "description"), options.overlay?.description, firstProseLine(parsed.body)) ?? "",
    ),
    MAX_DESCRIPTION_CHARS,
  );
  const created =
    parseLegacyTimestamp(fmString(data, "created")) ??
    parseLegacyTimestamp(fmNestedString(data, raw, "metadata", "created")) ??
    parseLegacyTimestamp(fmString(data, "updated")) ??
    parseLegacyTimestamp(fmNestedString(data, raw, "metadata", "modified")) ??
    mtime;
  const originPath = options.absPath;
  const originalId = stem;
  return {
    type: declaredType(legacyType) ?? typeFromLegacyTags(tags) ?? "reference",
    title,
    description,
    content: truncate(parsed.body, MAX_CONTENT_CHARS),
    scope: options.scope,
    project: options.scope === "project" ? options.project : undefined,
    projectName: options.scope === "project" ? options.projectName : undefined,
    tags,
    entities: [],
    importance: fmNumber(data, "importance"),
    pinned: options.overlay?.pinned || undefined,
    created,
    updated: created,
    links: dedupe([...stringList(data, "links"), ...stringList(data, "related"), ...extractWikiLinks(parsed.body)]),
    source: {
      harness: "claude",
      ts: created,
      migratedFrom: { system: "claude-code", path: originPath, originalId },
    },
    provenance: [`claude:${options.tree}`, `file:${relPath(options.root, originPath)}`],
    extra: {
      legacy: {
        harness: "claude",
        tree: options.tree,
        name: fmString(data, "name") ?? fmString(data, "title") ?? stem,
        metadata: Object.keys(meta).length > 0 ? meta : undefined,
      },
    },
  };
}

function stringList(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim() !== "") return [value.trim()];
  return [];
}

function dedupe(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

function relPath(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/");
}
