/**
 * ZCode migration source (best effort; the host may not have ZCode installed).
 *
 * Layout from the ZCode memory mechanism doc:
 *   `<root>/memories/projects/<slug>-<sha256(path)[:16]>/memory/`
 *     ├── MEMORY.md          (index)
 *     └── <topic>.md         (frontmatter: name, description, metadata.type)
 *
 * The 16-hex suffix is a hash of the *resolved, lowercased* project path and is
 * not reversible; attribution therefore requires `--path-map`, an explicit
 * `--project` fallback, or an existing decoded directory. Unresolved ZCode
 * records go to the unresolved bucket — never to the user scope.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import type { ImportRecord } from "@harnmem/core";

import { fmNumber, fmString, parseFrontmatter } from "../frontmatter.js";
import { attributeProject } from "../project-resolve.js";
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

export interface ZcodePaths {
  projectsRoot?: string;
  warnings: string[];
}

/** Locate `<...>/memories/projects` tolerantly; undefined when ZCode is absent. */
export async function locateZcodeRoot(sourcePath: string): Promise<ZcodePaths> {
  const warnings: string[] = [];
  const candidates: string[] = [];
  if (existsSync(sourcePath)) {
    const direct = join(sourcePath, "projects");
    if (existsSync(direct)) candidates.push(direct);
    candidates.push(sourcePath);
    const parentProjects = join(dirname(sourcePath), "projects");
    if (existsSync(parentProjects)) candidates.push(parentProjects);
  }
  for (const candidate of candidates) {
    try {
      const entries = await readdir(candidate, { withFileTypes: true });
      const projectDirs = entries.filter((e) => e.isDirectory());
      if (projectDirs.length === 0) continue;
      // A project dir either has memory/ or at least one .md entry besides MEMORY.md.
      const looksLikeProjects = projectDirs.some((d) => existsSync(join(candidate, d.name, "memory")));
      if (looksLikeProjects) return { projectsRoot: candidate, warnings };
    } catch {
      // keep trying
    }
  }
  warnings.push(`ZCode memory data not found at ${sourcePath} (nothing to import; skipped gracefully)`);
  return { projectsRoot: undefined, warnings };
}

export async function discoverZcode(options: DiscoverOptions): Promise<DiscoverResult> {
  const located = await locateZcodeRoot(options.sourcePath);
  const warnings = [...located.warnings];
  const items: ImportItem[] = [];
  const unresolved: UnresolvedGroup[] = [];
  const counts: DiscoverResult["counts"] = { files: 0, entries: 0, skipped: 0 };
  if (!located.projectsRoot) {
    return { harness: "zcode", sourceRoot: options.sourcePath, items, unresolved, counts, warnings };
  }

  const root = located.projectsRoot;
  const projectDirs = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dir of projectDirs) {
    const dirPath = join(root, dir);
    const attribution = await attributeProject({
      keys: [dir, dirPath],
      pathMap: options.pathMap,
      home: options.home,
      cwd: options.cwd,
      harness: "zcode",
      fallback: options.fallbackProject,
    });
    const files = await collectMarkdownFiles(dirPath);
    if (files.length === 0) {
      counts.skipped += 1;
      continue;
    }
    const records: ImportRecord[] = [];
    for (const file of files) {
      const absPath = join(dirPath, file);
      let raw: string;
      let mtime: number;
      try {
        raw = await readFile(absPath, "utf8");
        mtime = (await stat(absPath)).mtimeMs;
      } catch {
        counts.skipped += 1;
        warnings.push(`unreadable file ${absPath}`);
        continue;
      }
      counts.files += 1;
      const parsed = parseFrontmatter(raw);
      if (parsed.body.trim() === "") {
        counts.skipped += 1;
        warnings.push(`empty ZCode topic ${absPath}`);
        continue;
      }
      const meta = (parsed.data.metadata ?? {}) as Record<string, unknown>;
      const legacyType = fmString(parsed.data, "type") ?? (typeof meta.type === "string" ? meta.type : undefined);
      const stem = basename(file, ".md");
      const title = truncate(fmString(parsed.data, "name") ?? stem.replace(/[-_]+/g, " "), 80);
      const created =
        parseLegacyTimestamp(fmString(parsed.data, "created")) ??
        parseLegacyTimestamp(meta.createdAt) ??
        parseLegacyTimestamp(meta.created_at) ??
        mtime;
      const originalId = stem;
      const key = makeKey("zcode", relative(root, absPath), originalId);
      const record: ImportRecord = {
        type: mapZcodeType(legacyType),
        title,
        description: truncate(fmString(parsed.data, "description") ?? "", 200),
        content: truncate(parsed.body, MAX_CONTENT_CHARS),
        scope: "project",
        project: attribution.project?.id,
        projectName: attribution.project?.name,
        tags: extractHashtags(parsed.body),
        entities: [],
        importance: fmNumber(parsed.data, "importance"),
        created,
        updated: created,
        links: extractWikiLinks(parsed.body),
        source: {
          harness: "zcode",
          ts: created,
          migratedFrom: { system: "zcode", path: absPath, originalId },
        },
        provenance: [`zcode:${dir}`, `file:${file}`],
        extra: {
          legacy: {
            harness: "zcode",
            projectDir: dir,
            name: fmString(parsed.data, "name") ?? stem,
            metadata: meta,
          },
        },
      };
      counts.entries += 1;
      if (!attribution.project) {
        records.push(record);
        continue;
      }
      items.push({ key, sourceHash: hashRecord(record), originPath: absPath, record });
    }
    if (records.length > 0) {
      unresolved.push({
        key: dir,
        reason: attribution.reason ?? "unknown ZCode project",
        originPaths: records.map((r) => r.source?.migratedFrom?.path ?? dirPath),
        records,
      });
    }
  }

  return { harness: "zcode", sourceRoot: root, items, unresolved, counts, warnings };
}

async function collectMarkdownFiles(dirPath: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [join(dirPath, "memory"), dirPath];
  for (const dir of stack) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        if (entry.name.toUpperCase() === "MEMORY.MD") continue;
        if (!out.includes(entry.name)) out.push(entry.name);
      }
    } catch {
      // dir absent
    }
  }
  return out;
}

function mapZcodeType(value: string | undefined): ImportRecord["type"] {
  if (!value) return "reference";
  const lower = value.toLowerCase();
  if (lower.includes("preference") || lower.includes("rule") || lower.includes("反馈")) return "feedback";
  if (lower.includes("decision") || lower.includes("project") || lower.includes("决策")) return "project";
  if (lower.includes("user") || lower.includes("profile")) return "user";
  return asMemoryType(value, "reference");
}
