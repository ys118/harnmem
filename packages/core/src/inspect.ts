/**
 * Read-only projection of a HarnMem home.
 *
 * Presentation layers (the DSH sidebar panel, CLI `harnmem inspector`, future
 * web UI) need to answer "what does the memory system currently hold?". Every
 * other consumer of the store goes through the engine, which needs an index,
 * a retriever and a write pipeline; a viewer must not.
 *
 * Design constraints, deliberately enforced here:
 *
 * - **No engine, no writes.** `HarnMem.open()` registers the project and
 *   deploys prompt assets, i.e. it mutates `projects.json`. A viewer that is
 *   opened just to look around must not touch disk, and a second engine over
 *   the same home would race the adapter's engine.
 * - **No index dependency.** Records are read from their markdown files
 *   (`frontmatter` is the source of truth). `index/<shard>.json` is only
 *   *reported* (file size, staleness), never required; its `docTerms` /
 *   `postings` payload is far too large to ship to a browser.
 * - **No async store bootstrap.** `Store.init()` is not called: missing
 *   directories and files degrade to empty results instead of being created.
 *
 * Byte-sized reads are cached for a very short TTL so a single HTTP request
 * that needs the same shard twice (overview + list) reads the directory once.
 */
import { promises as fs } from "node:fs";
import { basename, join, relative } from "node:path";
import { DEFAULT_BUDGET } from "./config.js";
import { parseFrontmatter, recordFromFrontmatter } from "./frontmatter.js";
import { renderHotContextSync } from "./hot-context.js";
import { loadProjects, type ProjectRegistryEntry, type ProjectsFile } from "./project.js";
import { Store, shardKey, type ShardRef } from "./store.js";
import type { MemoryCategory, MemoryRecord, MemoryScope, MemoryStatus, MemoryType } from "./types.js";
import { estimateTokens, readJson, readTextIfExists, resolveHome, truncateText } from "./util.js";

/** Default shard cache TTL: long enough to dedupe one request, short enough to stay live. */
const DEFAULT_CACHE_TTL_MS = 250;
/** Registry cache TTL (`projects.json` changes rarely). */
const REGISTRY_CACHE_TTL_MS = 1000;
/** Characters of body shipped as a list preview. */
const PREVIEW_CHARS = 240;

/** Options for {@link MemoryInspector.open}. */
export interface MemoryInspectorOptions {
  /** HarnMem home; defaults to `HARNMEM_HOME` then `~/.harnmem`. */
  home?: string;
  /** Clock override for deterministic tests. */
  now?: number;
  /** Parsed-shard cache TTL in milliseconds; `0` disables caching. */
  cacheTtlMs?: number;
}

/** One diagnostics/warning row surfaced by the inspector. */
export interface InspectIssue {
  level: "warn" | "error";
  code: string;
  message: string;
}

/** A record file that failed to parse (the rest of the shard still renders). */
export interface InspectFileError {
  file: string;
  message: string;
}

/** Per-shard aggregate shown in the overview. */
export interface InspectShard {
  /** Shard name: `"user"` or the project id (`<slug>-<hash>`). */
  name: string;
  scope: MemoryScope;
  project: string | null;
  projectName: string | null;
  label: string;
  total: number;
  active: number;
  superseded: number;
  archived: number;
  pinned: number;
  bytes: number;
  tokens: number;
  indexBytes: number;
  lastUpdated: number | null;
}

/** List-row projection of one memory (no body). */
export interface InspectRow {
  id: string;
  type: MemoryType;
  category: MemoryCategory | null;
  scope: MemoryScope;
  project: string | null;
  projectName: string | null;
  title: string;
  description: string;
  preview: string;
  tags: string[];
  entities: string[];
  importance: number;
  confidence: number;
  pinned: boolean;
  status: MemoryStatus;
  created: number;
  updated: number;
  lastUsed: number | null;
  usedCount: number;
  validFrom: number;
  validTo: number | null;
  supersededBy: string | null;
  links: string[];
  supersedes: string[];
  evidence: number;
  bytes: number;
  tokens: number;
  harness: string;
}

/** Full projection of one memory, including the on-disk text. */
export interface InspectMemory extends InspectRow {
  /** Markdown body (frontmatter stripped). */
  content: string;
  /** Parsed frontmatter as stored. */
  frontmatter: Record<string, unknown>;
  /** Verbatim file contents. */
  raw: string;
  /** Path relative to the HarnMem home, POSIX separators. */
  filePath: string;
  /** Ids of records whose `links` point here (cross-shard). */
  backlinks: string[];
  /** Older versions, newest first, when `history` was requested. */
  history?: InspectRow[];
}

/** Project registry entry merged with on-disk shard facts. */
export interface InspectProject {
  id: string;
  slug: string;
  name: string;
  paths: string[];
  harnesses: string[];
  registered: boolean;
  shards: string[];
  total: number;
  pinned: number;
  lastUpdated: number | null;
}

/** Index health reported by the overview. */
export interface InspectIndexStatus {
  manifest: {
    seq: number;
    builtAt: number;
    bytes: number;
    shards: Array<{ name: string; docs: number }>;
  } | null;
  /** Current store sequence (`state/seq.json`). */
  seq: number;
  /** Manifest sequence is behind the store sequence. */
  stale: boolean;
  files: Array<{ shard: string; path: string; bytes: number; exists: boolean; docs: number | null; records: number }>;
}

/** The injected hot-index block, replayed from disk. */
export interface InspectContext {
  cwd: string | null;
  projectId: string | null;
  projectName: string | null;
  shards: string[];
  text: string;
  ids: string[];
  tokensEstimate: number;
  bytes: number;
  budgetTokens: number;
  hotEntries: number;
  atBudget: boolean;
}

/** Whole-home snapshot for the overview screen. */
export interface InspectOverview {
  version: 1;
  home: string;
  generatedAt: number;
  project: string | null;
  projectName: string | null;
  totals: {
    records: number;
    active: number;
    superseded: number;
    archived: number;
    pinned: number;
    bytes: number;
    tokens: number;
    shards: number;
    projects: number;
    trash: number;
    digests: number;
  };
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  byHarness: Record<string, number>;
  budget: { injectTokens: number; hotEntries: number; maxPinned: number };
  context: InspectContext;
  shards: InspectShard[];
  projects: InspectProject[];
  index: InspectIndexStatus;
  issues: InspectIssue[];
  fileErrors: InspectFileError[];
}

/** Result of {@link MemoryInspector.list}. */
export interface InspectList {
  shard: string;
  label: string;
  total: number;
  rows: InspectRow[];
  generatedAt: number;
}

/** Result of {@link MemoryInspector.indexText}. */
export interface InspectIndexText {
  text: string;
  bytes: number;
  parts: Array<{ shard: string; label: string; path: string; text: string; bytes: number }>;
  generatedAt: number;
}

/** Options for {@link MemoryInspector.list}. */
export interface InspectListOptions {
  /** `"all"` (default), `"user"`, or a project shard name. */
  shard?: string;
  /** Include superseded/archived records; defaults to `true`. */
  includeInactive?: boolean;
}

/** Options for {@link MemoryInspector.overview}. */
export interface InspectOverviewOptions {
  /** Working directory used to resolve the current project shard. */
  cwd?: string;
}

/** Options for {@link MemoryInspector.context}. */
export interface InspectContextOptions {
  cwd?: string;
  /** Override the injection token budget. */
  budgetTokens?: number;
  /** Override the hot-entry count. */
  hotEntries?: number;
}

/** Options for {@link MemoryInspector.read}. */
export interface InspectReadOptions {
  id: string;
  /** Include the superseded-version chain. */
  history?: boolean;
}

/** Options for {@link MemoryInspector.indexText}. */
export interface InspectIndexOptions {
  /** `"all"` (default), `"user"`, or a project shard name. */
  shard?: string;
}

interface ShardSnapshot {
  shard: ShardRef;
  records: MemoryRecord[];
  sizes: Map<string, number>;
  errors: InspectFileError[];
  indexText: string | null;
  indexBytes: number;
  loadedAt: number;
}

interface ManifestFile {
  version?: number;
  seq?: number;
  builtAt?: number;
  shards?: Array<{ name?: string; docs?: number }>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

function sortRows(a: InspectRow, b: InspectRow): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.importance !== b.importance) return b.importance - a.importance;
  if (a.updated !== b.updated) return b.updated - a.updated;
  if (a.created !== b.created) return b.created - a.created;
  return a.id.localeCompare(b.id);
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** `harnmem` project ids look like `<slug>-<10 chars>`; keep the slug part for display. */
function fallbackProjectName(id: string): string {
  const match = /^(.*)-[0-9a-z]{6,}$/u.exec(id);
  return match?.[1] ? match[1] : id;
}

function registryEntries(file: ProjectsFile): ProjectRegistryEntry[] {
  const byId = new Map<string, ProjectRegistryEntry>();
  for (const entry of Object.values(file.projects ?? {})) {
    if (!entry || typeof entry.id !== "string") continue;
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

function projectNameMap(file: ProjectsFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of registryEntries(file)) map.set(entry.id, entry.name || fallbackProjectName(entry.id));
  return map;
}

/**
 * Read-only view over one HarnMem home.
 *
 * @example
 * ```ts
 * const inspector = await MemoryInspector.open({ home });
 * const overview = await inspector.overview({ cwd });
 * const list = await inspector.list({ shard: "all" });
 * await inspector.close();
 * ```
 */
export class MemoryInspector {
  /** Resolved HarnMem home (absolute). */
  readonly home: string;
  /** Underlying store handle; only its read methods are used. */
  readonly store: Store;
  private readonly fixedNow: number | null;
  private readonly cacheTtlMs: number;
  private readonly snapshots = new Map<string, ShardSnapshot>();
  private registryCache: { at: number; file: ProjectsFile } | null = null;

  private constructor(options: { home: string; now?: number; cacheTtlMs?: number }) {
    this.home = options.home;
    this.store = new Store(options.home);
    this.fixedNow = options.now ?? null;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Open an inspector over `home` (resolved like the engine: explicit option,
   * then `HARNMEM_HOME`, then `~/.harnmem`). Never writes to disk.
   */
  static async open(options: MemoryInspectorOptions = {}): Promise<MemoryInspector> {
    return new MemoryInspector({
      home: resolveHome(options.home),
      now: options.now,
      cacheTtlMs: options.cacheTtlMs,
    });
  }

  /** Drop cached shards and registry state. */
  async close(): Promise<void> {
    this.snapshots.clear();
    this.registryCache = null;
  }

  private clock(): number {
    return this.fixedNow ?? Date.now();
  }

  private async registry(): Promise<ProjectsFile> {
    const now = this.clock();
    const ttl = Math.max(this.cacheTtlMs, REGISTRY_CACHE_TTL_MS);
    if (this.registryCache && now - this.registryCache.at < ttl) return this.registryCache.file;
    const file = await loadProjects(this.home);
    this.registryCache = { at: now, file };
    return file;
  }

  private async snapshot(shard: ShardRef): Promise<ShardSnapshot> {
    const key = shardKey(shard);
    const now = this.clock();
    const cached = this.snapshots.get(key);
    if (cached && this.cacheTtlMs > 0 && now - cached.loadedAt < this.cacheTtlMs) return cached;

    const dir = this.store.shardDir(shard);
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((file) => file.endsWith(".md") && file !== "MEMORY.md").sort();
    } catch {
      files = [];
    }

    const errors: InspectFileError[] = [];
    const loaded = await Promise.all(
      files.map(async (file) => {
        try {
          return { file, raw: await fs.readFile(join(dir, file), "utf8") };
        } catch (error) {
          errors.push({ file, message: messageOf(error) });
          return null;
        }
      }),
    );

    const records: MemoryRecord[] = [];
    const sizes = new Map<string, number>();
    for (const item of loaded) {
      if (!item) continue;
      const parsed = parseFrontmatter(item.raw);
      let record: MemoryRecord;
      try {
        record = recordFromFrontmatter(parsed.data, parsed.body, basename(item.file, ".md"), 0);
      } catch (error) {
        errors.push({ file: item.file, message: messageOf(error) });
        continue;
      }
      if (!record.id) record.id = basename(item.file, ".md");
      for (const message of parsed.errors) errors.push({ file: item.file, message });
      records.push(record);
      sizes.set(record.id, Buffer.byteLength(item.raw, "utf8"));
    }
    records.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));

    const indexText = await readTextIfExists(this.store.indexFile(shard));
    const snapshot: ShardSnapshot = {
      shard,
      records,
      sizes,
      errors,
      indexText,
      indexBytes: indexText ? Buffer.byteLength(indexText, "utf8") : 0,
      loadedAt: now,
    };
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  private async shardsFor(name: string): Promise<ShardRef[]> {
    const shards = await this.store.listShards();
    if (!name || name === "all") return shards;
    return shards.filter((shard) => shard.name === name);
  }

  private labelOf(shard: ShardRef, names: Map<string, string>): string {
    if (shard.scope === "user") return "user";
    const id = shard.project ?? shard.name;
    return names.get(id) ?? fallbackProjectName(id);
  }

  private row(record: MemoryRecord, shard: ShardRef, names: Map<string, string>, bytes: number): InspectRow {
    const project = record.project ?? (shard.scope === "project" ? shard.project ?? null : null);
    const projectName = record.projectName ?? (project ? names.get(project) ?? fallbackProjectName(project) : null);
    return {
      id: record.id,
      type: record.type,
      category: record.category ?? null,
      scope: record.scope,
      project,
      projectName,
      title: record.title,
      description: record.description,
      preview: truncateText(record.content.replace(/\s+/gu, " ").trim(), PREVIEW_CHARS),
      tags: record.tags,
      entities: record.entities,
      importance: record.importance,
      confidence: record.confidence,
      pinned: record.pinned,
      status: record.status,
      created: record.created,
      updated: record.updated,
      lastUsed: record.lastUsed ?? null,
      usedCount: record.usedCount,
      validFrom: record.validFrom,
      validTo: record.validTo,
      supersededBy: record.supersededBy,
      links: record.links,
      supersedes: record.supersedes,
      evidence: record.evidence,
      bytes,
      tokens: estimateTokens(record.content),
      harness: record.source?.harness ?? "unknown",
    };
  }

  private renderContext(options: { cwd?: string; budgetTokens?: number; hotEntries?: number }, names: Map<string, string>): InspectContext {
    const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET.injectTokens;
    const hotEntries = options.hotEntries ?? DEFAULT_BUDGET.hotEntries;
    const budget = { ...DEFAULT_BUDGET, injectTokens: budgetTokens, hotEntries };
    const result = renderHotContextSync({
      home: this.home,
      cwd: options.cwd,
      now: this.clock(),
      config: { budget },
    });
    const projectName = result.projectId ? names.get(result.projectId) ?? fallbackProjectName(result.projectId) : null;
    return {
      cwd: options.cwd ?? null,
      projectId: result.projectId,
      projectName,
      shards: result.shards,
      text: result.text,
      ids: result.ids,
      tokensEstimate: result.tokensEstimate,
      bytes: Buffer.byteLength(result.text, "utf8"),
      budgetTokens,
      hotEntries,
      atBudget: result.tokensEstimate >= budgetTokens,
    };
  }

  /** All project registry rows, merged with on-disk shard totals. */
  async projects(): Promise<InspectProject[]> {
    const registry = await this.registry();
    const shards = await this.store.listShards();
    const snapshots = await Promise.all(shards.map((shard) => this.snapshot(shard)));
    const merged = new Map<string, InspectProject>();

    for (const entry of registryEntries(registry)) {
      merged.set(entry.id, {
        id: entry.id,
        slug: entry.slug ?? entry.id,
        name: entry.name || fallbackProjectName(entry.id),
        paths: Array.isArray(entry.paths) ? entry.paths : [],
        harnesses: Array.isArray(entry.harnesses) ? entry.harnesses : [],
        registered: true,
        shards: [],
        total: 0,
        pinned: 0,
        lastUpdated: null,
      });
    }

    for (const snapshot of snapshots) {
      if (snapshot.shard.scope !== "project" || !snapshot.shard.project) continue;
      const id = snapshot.shard.project;
      const row =
        merged.get(id) ?? {
          id,
          slug: id,
          name: fallbackProjectName(id),
          paths: [],
          harnesses: [],
          registered: false,
          shards: [],
          total: 0,
          pinned: 0,
          lastUpdated: null,
        };
      row.shards.push(snapshot.shard.name);
      row.total += snapshot.records.length;
      row.pinned += snapshot.records.filter((record) => record.pinned && record.status === "active").length;
      for (const record of snapshot.records) {
        if (row.lastUpdated === null || record.updated > row.lastUpdated) row.lastUpdated = record.updated;
      }
      merged.set(id, row);
    }

    return [...merged.values()].sort((a, b) => (b.lastUpdated ?? 0) - (a.lastUpdated ?? 0) || a.name.localeCompare(b.name));
  }

  /** Whole-home snapshot used by the overview screen. */
  async overview(options: InspectOverviewOptions = {}): Promise<InspectOverview> {
    const registry = await this.registry();
    const names = projectNameMap(registry);
    const shards = await this.store.listShards();
    const snapshots = await Promise.all(shards.map((shard) => this.snapshot(shard)));

    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byHarness: Record<string, number> = {};
    const totals = {
      records: 0,
      active: 0,
      superseded: 0,
      archived: 0,
      pinned: 0,
      bytes: 0,
      tokens: 0,
      shards: snapshots.length,
      projects: 0,
      trash: 0,
      digests: 0,
    };
    const fileErrors: InspectFileError[] = [];
    const shardRows: InspectShard[] = [];

    for (const snapshot of snapshots) {
      const shardTotal = {
        name: snapshot.shard.name,
        scope: snapshot.shard.scope,
        project: snapshot.shard.project ?? null,
        projectName:
          snapshot.shard.scope === "project" && snapshot.shard.project
            ? names.get(snapshot.shard.project) ?? fallbackProjectName(snapshot.shard.project)
            : null,
        label: this.labelOf(snapshot.shard, names),
        total: snapshot.records.length,
        active: 0,
        superseded: 0,
        archived: 0,
        pinned: 0,
        bytes: 0,
        tokens: 0,
        indexBytes: snapshot.indexBytes,
        lastUpdated: null as number | null,
      };
      for (const record of snapshot.records) {
        const bytes = snapshot.sizes.get(record.id) ?? 0;
        const tokens = estimateTokens(record.content);
        shardTotal.bytes += bytes;
        shardTotal.tokens += tokens;
        if (record.status === "active") shardTotal.active += 1;
        else if (record.status === "superseded") shardTotal.superseded += 1;
        else if (record.status === "archived") shardTotal.archived += 1;
        if (record.pinned && record.status === "active") shardTotal.pinned += 1;
        if (shardTotal.lastUpdated === null || record.updated > shardTotal.lastUpdated) shardTotal.lastUpdated = record.updated;
        bump(byType, record.type);
        bump(byStatus, record.status);
        bump(byHarness, record.source?.harness ?? "unknown");
        totals.records += 1;
        totals.bytes += bytes;
        totals.tokens += tokens;
        if (record.status === "active") totals.active += 1;
        else if (record.status === "superseded") totals.superseded += 1;
        else if (record.status === "archived") totals.archived += 1;
        if (record.pinned && record.status === "active") totals.pinned += 1;
      }
      shardRows.push(shardTotal);
      fileErrors.push(...snapshot.errors.map((error) => ({ ...error, file: `${snapshot.shard.name}/${error.file}` })));
    }

    shardRows.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "user" ? -1 : 1));

    const projects = await this.projects();
    totals.projects = projects.length;

    const index = await this.indexStatus(snapshots);
    const context = this.renderContext({ cwd: options.cwd }, names);

    const issues: InspectIssue[] = [];
    if (shards.length === 0) issues.push({ level: "warn", code: "empty_home", message: `no shards under ${this.home}` });
    if (index.stale) {
      issues.push({
        level: "warn",
        code: "index_stale",
        message: `index manifest seq ${index.manifest?.seq ?? "?"} is behind store seq ${index.seq}`,
      });
    }
    for (const file of index.files) {
      if (file.records > 0 && !file.exists) {
        issues.push({ level: "warn", code: "index_missing", message: `shard ${file.shard} has records but no index file` });
      }
      if (file.exists && file.records === 0) {
        issues.push({ level: "warn", code: "index_orphan", message: `index/${basename(file.path)} has no records on disk` });
      }
    }
    for (const project of projects) {
      if (!project.registered) {
        issues.push({ level: "warn", code: "project_unregistered", message: `shard ${project.id} is not registered in projects.json` });
      }
    }
    const temporal = snapshots.flatMap((snapshot) =>
      snapshot.records.filter((record) => record.status === "active" && record.validTo !== null && record.validTo <= this.clock()),
    );
    if (temporal.length > 0) {
      issues.push({
        level: "warn",
        code: "temporal_conflict",
        message: `${temporal.length} active record(s) carry a validTo timestamp in the past`,
      });
    }
    if (context.atBudget) {
      issues.push({
        level: "warn",
        code: "injection_at_budget",
        message: `injected block reaches the ${context.budgetTokens}-token budget; entries were dropped`,
      });
    }
    for (const error of fileErrors) {
      issues.push({ level: "error", code: "file_unreadable", message: `${error.file}: ${error.message}` });
    }

    return {
      version: 1,
      home: this.home,
      generatedAt: this.clock(),
      project: context.projectId,
      projectName: context.projectName,
      totals: {
        ...totals,
        trash: await this.countFiles(join(this.home, "trash")),
        digests: await this.countDigests(),
      },
      byType,
      byStatus,
      byHarness,
      budget: { injectTokens: DEFAULT_BUDGET.injectTokens, hotEntries: DEFAULT_BUDGET.hotEntries, maxPinned: DEFAULT_BUDGET.maxPinned },
      context,
      shards: shardRows,
      projects,
      index,
      issues,
      fileErrors,
    };
  }

  private async indexStatus(snapshots: ShardSnapshot[]): Promise<InspectIndexStatus> {
    const dir = join(this.home, "index");
    const manifestPath = join(dir, "manifest.json");
    const rawManifest = await readJson<ManifestFile | null>(manifestPath, null);
    let manifestBytes = 0;
    try {
      manifestBytes = (await fs.stat(manifestPath)).size;
    } catch {
      manifestBytes = 0;
    }
    const manifestDocs = new Map<string, number>();
    for (const entry of rawManifest?.shards ?? []) {
      if (typeof entry?.name === "string" && typeof entry.docs === "number") manifestDocs.set(entry.name, entry.docs);
    }
    const recordCounts = new Map<string, number>();
    for (const snapshot of snapshots) recordCounts.set(shardKey(snapshot.shard), snapshot.records.length);

    let indexFiles: string[] = [];
    try {
      indexFiles = (await fs.readdir(dir)).filter((file) => file.endsWith(".json") && file !== "manifest.json").sort();
    } catch {
      indexFiles = [];
    }
    const files: InspectIndexStatus["files"] = [];
    for (const file of indexFiles) {
      const path = join(dir, file);
      const shard = basename(file, ".json");
      let bytes = 0;
      try {
        bytes = (await fs.stat(path)).size;
      } catch {
        bytes = 0;
      }
      files.push({
        shard,
        path: posix(relative(this.home, path)),
        bytes,
        exists: true,
        docs: manifestDocs.get(shard) ?? null,
        records: recordCounts.get(shard) ?? 0,
      });
    }
    // Shards with records but no index file are only visible from the store side.
    for (const [shard, records] of recordCounts) {
      if (records === 0 || files.some((file) => file.shard === shard)) continue;
      files.push({ shard, path: posix(relative(this.home, join(dir, `${shard}.json`))), bytes: 0, exists: false, docs: manifestDocs.get(shard) ?? null, records });
    }
    files.sort((a, b) => a.shard.localeCompare(b.shard));

    const seq = await this.store.getSeq();
    const manifestSeq = typeof rawManifest?.seq === "number" ? rawManifest.seq : null;
    const manifest =
      rawManifest && manifestSeq !== null
        ? {
            seq: manifestSeq,
            builtAt: typeof rawManifest.builtAt === "number" ? rawManifest.builtAt : 0,
            bytes: manifestBytes,
            shards: [...manifestDocs.entries()].map(([name, docs]) => ({ name, docs })),
          }
        : null;
    return { manifest, seq, stale: manifest !== null && manifest.seq !== seq, files };
  }

  private async countFiles(dir: string): Promise<number> {
    try {
      return (await fs.readdir(dir)).filter((file) => file.endsWith(".md")).length;
    } catch {
      return 0;
    }
  }

  private async countDigests(): Promise<number> {
    try {
      const dirs = await fs.readdir(join(this.home, "digests"), { withFileTypes: true });
      let total = 0;
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        total += await this.countFiles(join(this.home, "digests", dir.name));
      }
      return total;
    } catch {
      return 0;
    }
  }

  /** Memories in one shard (or all shards), newest-first per the panel order. */
  async list(options: InspectListOptions = {}): Promise<InspectList> {
    const registry = await this.registry();
    const names = projectNameMap(registry);
    const requested = options.shard ?? "all";
    const shards = await this.shardsFor(requested);
    const snapshots = await Promise.all(shards.map((shard) => this.snapshot(shard)));
    const rows: InspectRow[] = [];
    for (const snapshot of snapshots) {
      for (const record of snapshot.records) {
        rows.push(this.row(record, snapshot.shard, names, snapshot.sizes.get(record.id) ?? 0));
      }
    }
    rows.sort(sortRows);
    const filtered = options.includeInactive === false ? rows.filter((row) => row.status === "active") : rows;
    const label =
      requested === "all" || shards.length !== 1 ? "all" : shards[0] ? this.labelOf(shards[0], names) : requested;
    return { shard: requested, label, total: filtered.length, rows: filtered, generatedAt: this.clock() };
  }

  /** One memory with body, frontmatter, raw text, backlinks and optional history. */
  async read(options: InspectReadOptions): Promise<InspectMemory | null> {
    const registry = await this.registry();
    const names = projectNameMap(registry);
    const shards = await this.store.listShards();
    const snapshots = await Promise.all(shards.map((shard) => this.snapshot(shard)));

    let found: { snapshot: ShardSnapshot; record: MemoryRecord } | null = null;
    for (const snapshot of snapshots) {
      const record = snapshot.records.find((candidate) => candidate.id === options.id);
      if (record) {
        found = { snapshot, record };
        break;
      }
    }
    if (!found) return null;

    const { snapshot, record } = found;
    const filePath = this.store.recordPath(snapshot.shard, record.id);
    const raw = await readTextIfExists(filePath);
    const parsed = raw === null ? null : parseFrontmatter(raw);
    const bytes = raw === null ? snapshot.sizes.get(record.id) ?? 0 : Buffer.byteLength(raw, "utf8");
    const rows = this.row(record, snapshot.shard, names, bytes);
    const memory: InspectMemory = {
      ...rows,
      content: record.content,
      frontmatter: (parsed?.data ?? {}) as Record<string, unknown>,
      raw: raw ?? "",
      filePath: posix(relative(this.home, filePath)),
      backlinks: [
        ...new Set(
          snapshots.flatMap((candidate) =>
            candidate.records.filter((other) => other.id !== record.id && other.links.includes(record.id)).map((other) => other.id),
          ),
        ),
      ].sort(),
    };

    if (options.history) {
      const all = snapshots.flatMap((candidate) =>
        candidate.records.map((item) => ({ record: item, size: candidate.sizes.get(item.id) ?? 0, shard: candidate.shard })),
      );
      const byId = new Map(all.map((item) => [item.record.id, item]));
      const chain: InspectRow[] = [];
      const seen = new Set<string>([record.id]);
      let cursor: MemoryRecord | null = record;
      while (cursor?.supersededBy) {
        const next = byId.get(cursor.supersededBy);
        if (!next || seen.has(next.record.id)) break;
        seen.add(next.record.id);
        chain.push(this.row(next.record, next.shard, names, next.size));
        cursor = next.record;
      }
      memory.history = chain;
    }
    return memory;
  }

  /** Replay the injected hot-index block for a working directory. */
  async context(options: InspectContextOptions = {}): Promise<InspectContext> {
    const registry = await this.registry();
    return this.renderContext(options, projectNameMap(registry));
  }

  /** Verbatim `MEMORY.md` shard index text (what humans and models skim). */
  async indexText(options: InspectIndexOptions = {}): Promise<InspectIndexText> {
    const registry = await this.registry();
    const names = projectNameMap(registry);
    const requested = options.shard ?? "all";
    const shards = await this.shardsFor(requested);
    const snapshots = await Promise.all(shards.map((shard) => this.snapshot(shard)));
    const parts = snapshots.map((snapshot) => ({
      shard: snapshot.shard.name,
      label: this.labelOf(snapshot.shard, names),
      path: posix(relative(this.home, this.store.indexFile(snapshot.shard))),
      text: snapshot.indexText ?? "",
      bytes: snapshot.indexBytes,
    }));
    const text =
      parts.length === 0
        ? ""
        : parts.length === 1
          ? parts[0]?.text ?? ""
          : parts.map((part) => `<!-- harnmem shard: ${part.shard} -->\n\n${part.text}`).join("\n\n");
    return { text, bytes: Buffer.byteLength(text, "utf8"), parts, generatedAt: this.clock() };
  }
}

/** Convenience wrapper around {@link MemoryInspector.open}. */
export async function openInspector(options: MemoryInspectorOptions = {}): Promise<MemoryInspector> {
  return MemoryInspector.open(options);
}
