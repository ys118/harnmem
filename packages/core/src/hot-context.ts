/**
 * Synchronous hot-index reader for cold starts.
 *
 * Harnesses assemble the prompt before the adapter's async session bootstrap
 * has finished, so a snapshot built from the engine can still be empty on the
 * very first turn. This module renders the same injected block directly from
 * the persisted index files with `node:fs` synchronous calls, which makes
 * injection available immediately after process start. It is a read-only
 * fallback: the async engine path stays authoritative once ready.
 *
 * The layout itself is shared with `Retriever.buildContext` through
 * `layoutHotContext`, so both paths produce byte-identical blocks.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { budgetOf, retrievalOf } from "./config.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { DocMeta, ShardIndexJson } from "./indexer.js";
import { normalizePathKey, type ProjectsFile } from "./project.js";
import { layoutHotContext, renderContextText, type HotDigest } from "./retrieval.js";
import type { HarnMemConfig } from "./types.js";

/** Options accepted by {@link renderHotContextSync}. */
export interface SyncHotContextOptions {
  /** HarnMem home (already resolved; no `~` expansion here). */
  home: string;
  /** Working directory used to pick the project shard. */
  cwd?: string;
  /** Clock override for deterministic tests. */
  now?: number;
  /** Budget/retrieval overrides; omitted fields fall back to defaults. */
  config?: Partial<Pick<HarnMemConfig, "budget" | "retrieval">>;
}

/** Result of the synchronous cold-start render. */
export interface SyncHotContextResult {
  text: string;
  ids: string[];
  tokensEstimate: number;
  projectId: string | null;
  shards: string[];
}

interface CachedIndex {
  mtimeMs: number;
  size: number;
  docs: DocMeta[];
}

const indexCache = new Map<string, CachedIndex>();

function readJsonSync(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function statSignature(path: string): { mtimeMs: number; size: number } | null {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/** Read one persisted shard index, cached by (mtime, size). */
function readShardDocs(file: string): DocMeta[] {
  const signature = statSignature(file);
  if (!signature) return [];
  const cached = indexCache.get(file);
  if (cached && cached.mtimeMs === signature.mtimeMs && cached.size === signature.size) return cached.docs;
  try {
    const parsed = readJsonSync(file) as Partial<ShardIndexJson> | null;
    if (!parsed || !Array.isArray(parsed.docs)) return [];
    const docs = parsed.docs.filter((doc): doc is DocMeta => {
      if (typeof doc !== "object" || doc === null) return false;
      const candidate = doc as Partial<DocMeta>;
      return typeof candidate.id === "string" && typeof candidate.title === "string" && typeof candidate.status === "string";
    });
    indexCache.set(file, { ...signature, docs });
    return docs;
  } catch {
    return [];
  }
}

/** Resolve the project id whose recorded path best contains `cwd`. */
function resolveProjectId(home: string, cwd: string | undefined): string | null {
  if (!cwd) return null;
  const registries: ProjectsFile | null = (() => {
    try {
      const parsed = readJsonSync(join(home, "projects.json")) as Partial<ProjectsFile> | null;
      if (!parsed || typeof parsed !== "object" || !parsed.projects) return null;
      return { version: 1, projects: parsed.projects };
    } catch {
      return null;
    }
  })();
  if (!registries) return null;
  const target = normalizePathKey(cwd);
  let best: { id: string; length: number } | null = null;
  for (const entry of Object.values(registries.projects)) {
    if (!entry || typeof entry.id !== "string" || !Array.isArray(entry.paths)) continue;
    for (const path of entry.paths) {
      if (typeof path !== "string") continue;
      const normalized = normalizePathKey(path);
      if (target !== normalized && !target.startsWith(`${normalized}/`)) continue;
      if (!best || normalized.length > best.length) best = { id: entry.id, length: normalized.length };
    }
  }
  return best?.id ?? null;
}

/** Read digest pages for one shard without touching the async store. */
function readDigests(home: string, shard: string): HotDigest[] {
  const dir = join(home, "digests", shard);
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: HotDigest[] = [];
  for (const file of files) {
    try {
      const parsed = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
      const firstHeading = parsed.body.split("\n").find((line) => line.trim().startsWith("#"));
      out.push({
        title: firstHeading ? firstHeading.replace(/^#+\s*/, "").trim() : file.replace(/\.md$/, ""),
        body: parsed.body.trim(),
      });
    } catch {
      // skip unreadable digest
    }
  }
  return out;
}

/**
 * Render the injected hot-index block synchronously from disk.
 *
 * @returns the same block shape as `HarnMem.ensureContext()`, or an empty
 * `text` when the store has no active memory for the scopes in play.
 */
export function renderHotContextSync(options: SyncHotContextOptions): SyncHotContextResult {
  const home = options.home;
  const now = options.now ?? Date.now();
  const projectId = resolveProjectId(home, options.cwd);
  const shards = projectId ? ["user", projectId] : ["user"];

  const docs: DocMeta[] = [];
  for (const shard of shards) {
    docs.push(...readShardDocs(join(home, "index", `${shard}.json`)));
  }
  const digests: HotDigest[] = [];
  for (const shard of shards) digests.push(...readDigests(home, shard));

  const budgetConfig = budgetOf((options.config ?? {}) as HarnMemConfig);
  const retrieval = retrievalOf((options.config ?? {}) as HarnMemConfig);
  const layout = layoutHotContext(docs, digests, {
    now,
    budgetTokens: budgetConfig.injectTokens,
    maxPinned: budgetConfig.maxPinned,
    hotEntries: budgetConfig.hotEntries,
    decayPerHour: retrieval.decayPerHour,
  });
  const text = layout.hasContent ? renderContextText(layout.sections) : "";
  return {
    text,
    ids: layout.ids,
    tokensEstimate: layout.hasContent ? layout.tokensEstimate : 0,
    projectId,
    shards,
  };
}
