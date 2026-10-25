/**
 * Markdown source: any `.md`/`.mdx`/`.mdc`/`.markdown`/`.txt` tree (Obsidian
 * vaults, `memory-bank/`, `docs/adr/`, note dumps).
 *
 * Two modes:
 *  - `file` (default): one record per file — frontmatter fields win, the body is
 *    the content;
 *  - `heading`: split on `^#{1,2} ` outside fenced code blocks, one record per
 *    section (the heading becomes the title).
 *
 * Host instruction files (`CLAUDE.md`, `AGENTS.md`, …) and other harnesses'
 * `MEMORY.md` indexes are skipped by default unless `--include-all`, because the
 * hosts already inject that text and importing it would double-inject it.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import type { ImportRecord, MemoryScope, MemoryType } from "@harnmem/core";

import { UsageError } from "../args.js";
import { fmArray, fmBoolean, fmNestedString, fmNumber, fmString, parseFrontmatter, type FrontmatterValue } from "../frontmatter.js";
import {
  detectProject,
  findGitRepoRoot,
  PROJECT_ID_RE,
  registerProject,
  type ProjectInfo,
} from "../identity.js";
import {
  MAX_CONTENT_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_TITLE_CHARS,
  asNumber,
  asStringArray,
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
  stripMarkdownDecorations,
  truncate,
  typeFromLegacyTags,
  type DiscoverOptions,
  type DiscoverResult,
  type ImportItem,
} from "./types.js";

const SKIP_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".obsidian",
  ".trash",
  ".harnmem",
]);

/** Host-injected instruction files and other harnesses' memory indexes. */
const HOST_FILE_NAMES = new Set([
  "claude.md",
  "agents.md",
  "gemini.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  "memory.md",
]);

const MARKDOWN_EXT = /\.(md|mdx|mdc|markdown|txt)$/i;

const PATH_TYPE_HINTS: Array<[string[], MemoryType]> = [
  [["decisions", "adr", "rfcs"], "project"],
  [["rules", "policies", "conventions", "preferences"], "feedback"],
  [["lessons", "pitfalls", "troubleshooting", "notes"], "reference"],
  [["profile", "user", "about"], "user"],
];

const KNOWN_FRONTMATTER_KEYS = new Set([
  "title",
  "name",
  "subject",
  "description",
  "summary",
  "desc",
  "type",
  "metadata",
  "metadata_type",
  "tags",
  "keywords",
  "categories",
  "created",
  "date",
  "created_at",
  "updated",
  "modified",
  "importance",
  "priority",
  "pinned",
  "star",
  "starred",
  "scope",
  "project",
  "project_id",
  "links",
  "related",
  "category",
  "sensitive",
  "private",
  "secret",
]);

interface WalkResult {
  files: string[];
  hostFiles: string[];
}

async function collectFiles(root: string, maxFiles: number, includeAll: boolean): Promise<WalkResult> {
  const rootInfo = await stat(root);
  if (rootInfo.isFile()) {
    if (!MARKDOWN_EXT.test(root)) throw new UsageError(`not a markdown/text file: ${root}`);
    const isHost = HOST_FILE_NAMES.has(basename(root).toLowerCase());
    if (isHost && !includeAll) return { files: [], hostFiles: [root] };
    return { files: [root], hostFiles: [] };
  }
  const files: string[] = [];
  const hostFiles: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name.toLowerCase())) stack.push(abs);
        continue;
      }
      if (!entry.isFile() || !MARKDOWN_EXT.test(entry.name)) continue;
      if (!includeAll && HOST_FILE_NAMES.has(entry.name.toLowerCase())) {
        hostFiles.push(abs);
        continue;
      }
      files.push(abs);
      if (files.length > maxFiles) {
        throw new UsageError(
          `markdown source tree has more than ${maxFiles} files: ${root} (narrow --path or raise --max-files)`,
        );
      }
    }
  }
  return { files: files.sort(), hostFiles: hostFiles.sort() };
}

interface Section {
  heading?: string;
  text: string;
}

/**
 * Split on level 1–2 headings outside fenced code blocks. A text-only file (or
 * one with only `###`+ headings) returns a single preamble section.
 */
function splitAtHeadings(body: string): Section[] {
  const sections: Section[] = [];
  let heading: string | undefined;
  let buffer: string[] = [];
  let fenced = false;
  const emit = (): void => {
    const text = buffer.join("\n").trim();
    buffer = [];
    if (text === "" && heading === undefined) return;
    sections.push({ heading, text });
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      fenced = !fenced;
      buffer.push(line);
      continue;
    }
    const match = fenced ? null : /^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      buffer.push(line);
      continue;
    }
    emit();
    heading = collapseWhitespace(stripMarkdownDecorations(match[1] ?? "")) || "untitled section";
  }
  emit();
  return sections;
}

function headingSlug(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "section";
}

function firstString(data: Record<string, FrontmatterValue>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = fmString(data, key);
    if (value !== undefined && value.trim() !== "") return value;
  }
  return undefined;
}

function firstNumber(data: Record<string, FrontmatterValue>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = fmNumber(data, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstBoolean(data: Record<string, FrontmatterValue>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = fmBoolean(data, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** `type`, `metadata_type`, inline-JSON `metadata.type`, or a nested `metadata:` map. */
function metadataType(data: Record<string, FrontmatterValue>, raw: string): string | undefined {
  const direct = fmString(data, "type");
  if (direct !== undefined && direct.trim() !== "") return direct;
  const nested = fmString(data, "metadata_type");
  if (nested !== undefined && nested.trim() !== "") return nested;
  return fmNestedString(data, raw, "metadata", "type");
}

function inferTypeFromPath(relPath: string): MemoryType | undefined {
  const segments = relPath.split("/").slice(0, -1).map((part) => part.toLowerCase());
  for (const segment of segments) {
    for (const [names, type] of PATH_TYPE_HINTS) {
      if (names.includes(segment)) return type;
    }
  }
  return undefined;
}

interface Attribution {
  scope: MemoryScope;
  project?: string;
  projectName?: string;
  /** Directory that fell back to the user scope (aggregated into one warning). */
  userFallbackDir?: string;
}

async function attribute(
  absPath: string,
  data: Record<string, FrontmatterValue>,
  options: DiscoverOptions,
  gitCache: Map<string, ProjectInfo | null>,
  invalidProjectIds: Set<string>,
): Promise<Attribution> {
  const scopeRaw = firstString(data, ["scope"])?.toLowerCase();
  if (scopeRaw === "user") return { scope: "user" };

  const projectRaw = firstString(data, ["project", "project_id"]);
  if (projectRaw) {
    if (PROJECT_ID_RE.test(projectRaw)) return { scope: "project", project: projectRaw };
    invalidProjectIds.add(projectRaw);
  }

  const dir = dirname(absPath);
  let gitProject: ProjectInfo | null;
  if (gitCache.has(dir)) {
    gitProject = gitCache.get(dir) ?? null;
  } else {
    const root = await findGitRepoRoot(dir);
    gitProject = root ? await detectProject(root) : null;
    if (gitProject) await registerProject(options.home, gitProject, "cli");
    gitCache.set(dir, gitProject);
  }
  if (gitProject) {
    return { scope: "project", project: gitProject.id, projectName: gitProject.name };
  }
  if (options.fallbackProject) {
    return {
      scope: "project",
      project: options.fallbackProject.id,
      projectName: options.fallbackProject.name,
    };
  }
  return { scope: "user", userFallbackDir: dir };
}

export async function discoverMd(options: DiscoverOptions): Promise<DiscoverResult> {
  const root = options.sourcePath;
  const maxFiles = options.maxFiles ?? 5000;
  const includeAll = options.includeAll === true;
  const mode = options.mdMode ?? "file";
  const warnings: string[] = [];
  const items: ImportItem[] = [];
  const counts: DiscoverResult["counts"] = { files: 0, entries: 0, skipped: 0 };

  const walk = await collectFiles(root, maxFiles, includeAll);
  counts.files = walk.files.length;
  counts.skipped = walk.hostFiles.length;
  if (walk.hostFiles.length > 0) {
    const sample = walk.hostFiles.slice(0, 5).map((file) => relative(root, file).replace(/\\/g, "/"));
    warnings.push(
      `skipped ${walk.hostFiles.length} host/instruction file(s) (${sample.join(", ")}${
        walk.hostFiles.length > sample.length ? ", …" : ""
      }); pass --include-all to import them`,
    );
  }

  const gitCache = new Map<string, ProjectInfo | null>();
  const invalidProjectIds = new Set<string>();
  const userFallbackDirs = new Set<string>();
  const emptyFiles: string[] = [];
  const rootIsFile = walk.files.length === 1 && (await stat(root)).isFile();
  const sourceRoot = rootIsFile ? dirname(root) : root;

  for (const absPath of walk.files) {
    const raw = await readFile(absPath, "utf8");
    const { data, body, hasFrontmatter } = parseFrontmatter(raw);
    const relPath = (rootIsFile ? basename(absPath) : relative(sourceRoot, absPath)).replace(/\\/g, "/");
    const stem = basename(absPath);
    const attribution = await attribute(absPath, data, options, gitCache, invalidProjectIds);
    if (attribution.userFallbackDir) userFallbackDirs.add(attribution.userFallbackDir);

    const declared = declaredType(metadataType(data, hasFrontmatter ? raw : ""));
    const fmTags = asStringArray([
      ...fmArray(data, "tags"),
      ...fmArray(data, "keywords"),
      ...fmArray(data, "categories"),
    ]);
    const fmLinks = asStringArray([...fmArray(data, "links"), ...fmArray(data, "related")]);
    const fmTitle = firstString(data, ["title", "name", "subject"]);
    const fmDescription = firstString(data, ["description", "summary", "desc"]);
    const created = parseLegacyTimestamp(firstString(data, ["created", "date", "created_at"]));
    const updated = parseLegacyTimestamp(firstString(data, ["updated", "modified"])) ?? created;
    const importanceRaw = firstNumber(data, ["importance", "priority"]);
    const importance =
      importanceRaw === undefined ? undefined : Math.max(0, Math.min(10, Math.round(importanceRaw)));
    const pinned = firstBoolean(data, ["pinned", "star", "starred"]) ?? false;
    const category = firstString(data, ["category"]);
    const sensitive = firstBoolean(data, ["sensitive", "private", "secret"]);
    const unknownFrontmatter: Record<string, FrontmatterValue> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!KNOWN_FRONTMATTER_KEYS.has(key)) unknownFrontmatter[key] = value;
    }

    const sections: Section[] = mode === "heading" ? splitAtHeadings(body) : [{ text: body }];
    const hasHeadings = sections.some((section) => section.heading !== undefined);
    const effective = mode === "heading" && hasHeadings ? sections : [{ text: body }];
    const slugCounts = new Map<string, number>();

    for (let index = 0; index < effective.length; index++) {
      const section = effective[index];
      if (!section) continue;
      let content = section.text;
      let title: string;
      let description: string;
      let originalId: string;

      if (section.heading !== undefined) {
        title = truncate(section.heading, MAX_TITLE_CHARS);
        description = truncate(collapseWhitespace(firstProseLine(content) ?? ""), MAX_DESCRIPTION_CHARS);
        const baseSlug = headingSlug(section.heading);
        const seen = (slugCounts.get(baseSlug) ?? 0) + 1;
        slugCounts.set(baseSlug, seen);
        const slug = seen === 1 ? baseSlug : `${baseSlug}-${seen}`;
        originalId = `heading:${relPath}#${slug}`;
      } else {
        const headingTitle = firstHeading(content) ?? firstProseLine(content);
        title = truncate(
          collapseWhitespace(fmTitle ?? headingTitle ?? humanizeStem(stem)),
          MAX_TITLE_CHARS,
        );
        description = truncate(collapseWhitespace(fmDescription ?? firstProseLine(content) ?? ""), MAX_DESCRIPTION_CHARS);
        originalId = `file:${relPath}`;
      }
      if (title === "" && content.trim() === "") {
        emptyFiles.push(relPath);
        continue;
      }
      if (content.length > MAX_CONTENT_CHARS) {
        content = truncate(content, MAX_CONTENT_CHARS);
        warnings.push(`${relPath}: content truncated to ${MAX_CONTENT_CHARS} characters`);
      }

      const inferred =
        declared ??
        typeFromLegacyTags(fmTags) ??
        inferTypeFromPath(relPath) ??
        "reference";
      const type: MemoryType = inferred;
      const scope: MemoryScope = attribution.scope;
      const record: ImportRecord = {
        type,
        title: title || humanizeStem(stem),
        description,
        content,
        category: category as ImportRecord["category"],
        scope,
        project: scope === "project" ? attribution.project : undefined,
        projectName: scope === "project" ? attribution.projectName : undefined,
        tags: [...new Set([...fmTags, ...extractHashtags(content)])].slice(0, 64),
        importance,
        pinned,
        created,
        updated,
        source: {
          harness: "md",
          ts: created ?? Date.now(),
          migratedFrom: { system: "markdown", path: absPath, originalId },
        },
        provenance: [`md:${relPath}`],
        links: [...new Set([...fmLinks, ...extractWikiLinks(content)])],
        sensitive,
        extra: {
          legacy: {
            mode: section.heading !== undefined ? "heading" : "file",
            name: title,
            ...(section.heading !== undefined ? { heading: section.heading } : {}),
          },
          ...(Object.keys(unknownFrontmatter).length > 0 ? { frontmatter: unknownFrontmatter } : {}),
        },
      };
      items.push({
        key: makeKey("md", relPath, originalId),
        sourceHash: hashRecord(record),
        originPath: absPath,
        record,
      });
    }
  }

  if (emptyFiles.length > 0) {
    counts.skipped += emptyFiles.length;
    warnings.push(
      `skipped ${emptyFiles.length} empty file(s) (no body text and no title): ${emptyFiles.slice(0, 5).join(", ")}${
        emptyFiles.length > 5 ? ", …" : ""
      }`,
    );
  }
  if (userFallbackDirs.size > 0) {
    const sample = [...userFallbackDirs].slice(0, 3).join(", ");
    warnings.push(
      `${userFallbackDirs.size} director${userFallbackDirs.size === 1 ? "y" : "ies"} ${userFallbackDirs.size === 1 ? "has" : "have"} no git repository; ` +
        `records were imported as user scope (pass --project <path|id> to attribute them): ${sample}`,
    );
  }
  if (invalidProjectIds.size > 0) {
    warnings.push(
      `ignored invalid project id(s) (expected <slug>-<10 hex>): ${[...invalidProjectIds].slice(0, 5).join(", ")}`,
    );
  }
  if (items.length === 0) warnings.push(`no importable markdown records found under ${root}`);

  counts.entries = items.length;
  return {
    harness: "md",
    sourceRoot: root,
    items,
    unresolved: [],
    counts,
    warnings,
  };
}
