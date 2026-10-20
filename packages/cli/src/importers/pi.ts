/**
 * pi migration source: `<pi agent dir>/memory/`.
 *
 * MEMORY.md is an append-only markdown log whose entries are delimited by HTML
 * comment markers:
 *   `<!-- 2026-09-19 14:46:48 [01a0b7fd] -->`   (timestamp + session-id prefix)
 *   `<!-- 2026-09-19 PINNED -->`               (pinned long-term entry)
 *   `<!-- 2026-09-19 -->`                      (date restatement *inside* the
 *                                               entry that started above it)
 * Daily notes live in `daily/YYYY-MM-DD.md` with the same markers and
 * project-scoped bullets; `SCRATCHPAD.md` and `recovery/*.json` are ephemeral.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ImportRecord } from "@harnmem/core";

import { attributeProject } from "../project-resolve.js";
import { readPiSessionCwds, type PiSessionCwds } from "../session-cwd.js";
import {
  MAX_CONTENT_CHARS,
  collapseWhitespace,
  extractHashtags,
  extractWikiLinks,
  hashRecord,
  makeKey,
  parseLegacyTimestamp,
  stripMarkdownDecorations,
  truncate,
  type DiscoverOptions,
  type DiscoverResult,
  type ImportItem,
  type UnresolvedGroup,
} from "./types.js";

export interface PiBlock {
  date: string;
  time?: string;
  hash?: string;
  pinned: boolean;
  text: string;
}

const MARKER_RE = /^<!--\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}:\d{2}))?(?:\s+\[([0-9a-f]{6,16})\])?(?:\s+(PINNED))?\s*-->\s*$/;
const BARE_DATE_RE = /^<!--\s*\d{4}-\d{2}-\d{2}\s*-->\s*$/;

/** Split a pi memory file into entries. Bare date markers are annotations. */
export function parsePiBlocks(raw: string): PiBlock[] {
  const lines = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const blocks: PiBlock[] = [];
  let current: Omit<PiBlock, "text"> | null = null;
  const buffer: string[] = [];

  const flush = (): void => {
    if (!current) return;
    const text = buffer
      .filter((line) => !BARE_DATE_RE.test(line.trim()))
      .join("\n")
      .replace(/^\n+/, "")
      .replace(/\s+$/, "");
    if (text.trim() !== "") blocks.push({ ...current, text });
    buffer.length = 0;
    current = null;
  };

  for (const line of lines) {
    const marker = MARKER_RE.exec(line.trim());
    if (marker) {
      const isBare = !marker[2] && !marker[3] && !marker[4];
      if (isBare) continue; // date restatement within the current entry
      flush();
      current = {
        date: marker[1] ?? "",
        time: marker[2],
        hash: marker[3],
        pinned: Boolean(marker[4]),
      };
      continue;
    }
    if (current) buffer.push(line);
  }
  flush();
  return blocks;
}

function stripLeadingTags(line: string): string {
  return line.replace(/^(?:#[\p{L}\p{N}][\p{L}\p{N}_/-]*\s*)+/u, "").trim();
}

/** Title rules: heading lines keep their text; prose stops at the first clause break. */
export function derivePiTitle(text: string): string {
  const firstLine = stripMarkdownDecorations(
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "",
  );
  const withoutTags = stripLeadingTags(firstLine);
  if (withoutTags === "") return "untitled pi memory";
  if (firstLine.startsWith("##") || firstLine.startsWith("# ")) return truncate(withoutTags, 80);
  const stripped = stripMarkdownDecorations(withoutTags);
  for (const stop of ["；", "。", "：", ":", "（", "("]) {
    const idx = stripped.indexOf(stop);
    if (idx >= 8 && idx <= 80) return truncate(stripped.slice(0, idx).trim(), 80);
  }
  return truncate(stripped, 80);
}

function describePiBlock(text: string, title: string): string {
  const lines = text
    .split("\n")
    .map((line) => stripMarkdownDecorations(stripLeadingTags(line.trim())))
    .filter((line) => line !== "" && line !== title);
  return truncate(collapseWhitespace(lines[0] ?? title), 200);
}

export async function discoverPi(options: DiscoverOptions): Promise<DiscoverResult> {
  const memoryRoot = options.sourcePath;
  const warnings: string[] = [];
  const items: ImportItem[] = [];
  const unresolved: UnresolvedGroup[] = [];
  const counts: DiscoverResult["counts"] = { files: 0, entries: 0, skipped: 0, dailyEntries: 0 };
  const sessions: PiSessionCwds = options.sessionsRoot
    ? await readPiSessionCwds(options.sessionsRoot)
    : { byProjectKey: new Map(), byShortSession: new Map(), bySession: new Map() };
  if (sessions.byProjectKey.size === 0) {
    warnings.push(
      options.sessionsRoot
        ? `no pi session logs found under ${options.sessionsRoot}: daily entries need --project or --path-map`
        : "no pi session log root supplied: daily entries need --project or --path-map",
    );
  }

  const mainFile = join(memoryRoot, "MEMORY.md");
  try {
    const raw = await readFile(mainFile, "utf8");
    const mtime = (await stat(mainFile)).mtimeMs;
    counts.files += 1;
    const blocks = parsePiBlocks(raw);
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (!block) continue;
      const item = blockToItem({
        block,
        index: i,
        originPath: mainFile,
        relPath: "MEMORY.md",
        scope: "user",
        project: undefined,
        mtime,
        fallbackType: "user",
      });
      if (!item) {
        counts.skipped += 1;
        warnings.push(`empty MEMORY.md block at ${block.date} #${i}`);
        continue;
      }
      items.push(item.item);
      counts.entries += 1;
    }
  } catch (err) {
    throw new Error(`pi MEMORY.md not readable: ${mainFile} (${(err as Error).message})`);
  }

  if (options.includeDaily) {
    const dailyDir = join(memoryRoot, "daily");
    let files: string[] = [];
    try {
      files = (await readdir(dailyDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort();
    } catch {
      warnings.push(`no daily directory at ${dailyDir} (skipped)`);
    }
    for (const file of files) {
      const absPath = join(dailyDir, file);
      const raw = await readFile(absPath, "utf8");
      const mtime = (await stat(absPath)).mtimeMs;
      counts.files += 1;
      const blocks = parsePiBlocks(raw);
      // Resolve the project once per daily file: all blocks share a date.
      const hash = blocks.find((b) => b.hash)?.hash;
      const recovered = hash ? sessions.byShortSession.get(hash) : undefined;
      const attribution = await attributeProject({
        keys: [file, absPath, ...(hash ? [hash] : [])],
        pathMap: options.pathMap,
        home: options.home,
        cwd: options.cwd,
        harness: "pi",
        sessionCwd: recovered?.cwd,
        fallback: options.fallbackProject,
      });
      if (!attribution.project) {
        const group: UnresolvedGroup = {
          key: `${hash ?? file}`,
          reason: attribution.reason ?? "unknown project",
          originPaths: [absPath],
          records: [],
        };
        for (let i = 0; i < blocks.length; i++) {
          const block = blocks[i];
          if (!block) continue;
          const item = blockToItem({
            block,
            index: i,
            originPath: absPath,
            relPath: `daily/${file}`,
            scope: "project",
            project: undefined,
            mtime,
            fallbackType: "reference",
          });
          if (item) group.records.push(item.item.record);
          else counts.skipped += 1;
        }
        unresolved.push(group);
        continue;
      }
      if (attribution.guessed) warnings.push(`daily/${file} attributed by ${attribution.reason ?? "heuristic"}`);
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!block) continue;
        const item = blockToItem({
          block,
          index: i,
          originPath: absPath,
          relPath: `daily/${file}`,
          scope: "project",
          project: attribution.project,
          mtime,
          fallbackType: "reference",
        });
        if (!item) {
          counts.skipped += 1;
          continue;
        }
        items.push(item.item);
        counts.entries += 1;
        counts.dailyEntries = (counts.dailyEntries ?? 0) + 1;
      }
    }
  } else {
    warnings.push("daily notes skipped (--no-daily)");
  }

  // Ephemeral / session state is intentionally not migrated.
  for (const name of ["SCRATCHPAD.md", "recovery"]) {
    try {
      await stat(join(memoryRoot, name));
      warnings.push(`${name} present but not imported (ephemeral scratch/session state)`);
    } catch {
      // absent
    }
  }

  return { harness: "pi", sourceRoot: memoryRoot, items, unresolved, counts, warnings };
}

function blockToItem(options: {
  block: PiBlock;
  index: number;
  originPath: string;
  relPath: string;
  scope: "user" | "project";
  project?: { id: string; name: string };
  mtime: number;
  fallbackType: "user" | "reference";
}): { item: ImportItem } | null {
  const { block } = options;
  if (block.text.trim() === "") return null;
  const tags = extractHashtags(block.text);
  const type = typeFromTags(tags) ?? options.fallbackType;
  const title = derivePiTitle(block.text);
  const created = parseLegacyTimestamp(`${block.date}${block.time ? ` ${block.time}` : ""}`) ?? options.mtime;
  const originalId = block.hash ? `${block.date}-${block.hash}-${options.index}` : `${block.date}-${options.index}`;
  const key = makeKey("pi", options.relPath, originalId);
  const record: ImportRecord = {
    type,
    title,
    description: describePiBlock(block.text, title),
    content: truncate(block.text, MAX_CONTENT_CHARS),
    scope: options.scope,
    project: options.scope === "project" ? options.project?.id : undefined,
    projectName: options.scope === "project" ? options.project?.name : undefined,
    tags,
    entities: [],
    pinned: block.pinned,
    created,
    updated: created,
    links: extractWikiLinks(block.text),
    source: {
      harness: "pi",
      session: block.hash,
      ts: created,
      migratedFrom: { system: "pi-memory", path: options.originPath, originalId },
    },
    provenance: [`pi:${options.relPath}`, `marker:${block.date}${block.hash ? `#${block.hash}` : ""}`],
    extra: {
      legacy: {
        harness: "pi-memory",
        file: options.relPath,
        date: block.date,
        time: block.time ?? null,
        sessionHash: block.hash ?? null,
        pinnedMarker: block.pinned,
      },
    },
  };
  return { item: { key, sourceHash: hashRecord(record), originPath: options.originPath, record } };
}

function typeFromTags(tags: string[]): ImportRecord["type"] | undefined {
  const lower = tags.map((t) => t.toLowerCase());
  const has = (...names: string[]): boolean => names.some((n) => lower.includes(n));
  if (has("decision", "决策")) return "project";
  if (has("rule", "preference", "workflow", "规则", "偏好", "红线", "p0")) return "feedback";
  if (has("project", "项目")) return "project";
  if (has("lesson", "pitfall", "tooling", "教训", "坑", "工具")) return "reference";
  if (has("user", "用户")) return "user";
  return undefined;
}

export { relative };
