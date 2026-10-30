/**
 * Filesystem store: the single source of truth. One directory per scope shard,
 * one markdown file per memory, JSON for state/index. No database.
 *
 * Layout (docs/design/02-data-model.md):
 *   memories/user/<id>.md
 *   memories/projects/<projectId>/<id>.md
 *   state/seq, state/audit.jsonl, state/cursors.json
 *   index/manifest.json, index/<shard>.json
 *   digests/<shard>/*.md
 *   sessions/<date>/<harness>_<id>.jsonl
 *   trash/<ts>-<id>.md
 */
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { MemoryRecord, MemoryScope, TranscriptMessage } from "./types.js";
import { parseFrontmatter, recordFromFrontmatter, recordFileName, serializeRecord } from "./frontmatter.js";
import { atomicWriteFile, ensureDir, normalizeNewlines, pathExists, readJson, writeJson } from "./util.js";

export interface ShardRef {
  scope: MemoryScope;
  /** projectId for project scope; undefined for user scope. */
  project?: string;
  /** Directory name used in paths, e.g. "user" or the projectId. */
  name: string;
}

export interface ShardRecords {
  shard: ShardRef;
  records: MemoryRecord[];
  errors: { file: string; message: string }[];
}

export interface AuditEntry {
  seq?: number;
  ts: number;
  kind: string;
  harness?: string;
  session?: string;
  [key: string]: unknown;
}

export interface DigestEntry {
  name: string;
  title: string;
  body: string;
  updated?: number;
}

export interface UsageEntry {
  lastUsed: number;
  usedCount: number;
}

export class Store {
  readonly home: string;
  private seqCache: number | null = null;
  private shardSeqCache: Map<string, number> | null = null;

  constructor(home: string) {
    this.home = home;
  }

  path(...parts: string[]): string {
    return join(this.home, ...parts);
  }

  get memoriesDir(): string {
    return this.path("memories");
  }

  get stateDir(): string {
    return this.path("state");
  }

  get indexPath(): string {
    return this.path("index");
  }

  get trashDir(): string {
    return this.path("trash");
  }

  async init(): Promise<void> {
    await Promise.all([
      ensureDir(this.path("memories", "user")),
      ensureDir(this.path("memories", "projects")),
      ensureDir(this.stateDir),
      ensureDir(this.indexPath),
      ensureDir(this.trashDir),
      ensureDir(this.path("digests")),
      ensureDir(this.path("sessions")),
      ensureDir(this.path("prompts")),
      ensureDir(this.path("data")),
    ]);
    if (!(await pathExists(this.path("VERSION")))) {
      await atomicWriteFile(this.path("VERSION"), "1\n");
    }
  }

  shardRef(scope: MemoryScope, projectId?: string): ShardRef {
    if (scope === "user") return { scope, name: "user" };
    if (!projectId) throw new Error("project scope requires a projectId");
    return { scope, project: projectId, name: projectId };
  }

  shardDir(shard: ShardRef): string {
    return shard.scope === "user"
      ? this.path("memories", "user")
      : this.path("memories", "projects", sanitizeFilePart(shard.project as string));
  }

  indexFile(shard: ShardRef): string {
    return join(this.shardDir(shard), "MEMORY.md");
  }

  digestDir(shard: ShardRef): string {
    return this.path("digests", shard.name);
  }

  recordPath(shard: ShardRef, id: string): string {
    return join(this.shardDir(shard), recordFileName(id));
  }

  async listShards(): Promise<ShardRef[]> {
    const out: ShardRef[] = [];
    if (await pathExists(this.path("memories", "user"))) out.push({ scope: "user", name: "user" });
    const projectsDir = this.path("memories", "projects");
    if (await pathExists(projectsDir)) {
      for (const entry of await fs.readdir(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        out.push({ scope: "project", project: entry.name, name: entry.name });
      }
    }
    return out;
  }

  /** Read every `.md` file in a shard (excluding MEMORY.md). */
  async readShard(shard: ShardRef): Promise<ShardRecords> {
    const dir = this.shardDir(shard);
    const records: MemoryRecord[] = [];
    const errors: { file: string; message: string }[] = [];
    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      return { shard, records, errors };
    }
    for (const file of files) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue;
      const full = join(dir, file);
      try {
        const raw = await fs.readFile(full, "utf8");
        const parsed = parseFrontmatter(raw);
        if (parsed.noFrontmatter) {
          // A truncated/corrupt file must not resurrect as a zero-time
          // "(untitled)" active record; surface it as a read error instead.
          errors.push({ file: full, message: "missing frontmatter; record skipped" });
          continue;
        }
        const fallbackId = basename(file, ".md");
        const record = recordFromFrontmatter(parsed.data, parsed.body, fallbackId, 0);
        record.id = record.id || fallbackId;
        if (parsed.errors.length > 0) errors.push({ file: full, message: parsed.errors.join("; ") });
        records.push(record);
      } catch (error) {
        errors.push({ file: full, message: (error as Error).message });
      }
    }
    records.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    return { shard, records, errors };
  }

  async readRecord(shard: ShardRef, id: string): Promise<MemoryRecord | null> {
    const file = this.recordPath(shard, id);
    try {
      const raw = await fs.readFile(file, "utf8");
      const parsed = parseFrontmatter(raw);
      const record = recordFromFrontmatter(parsed.data, parsed.body, id, 0);
      record.id = record.id || id;
      return record;
    } catch {
      return null;
    }
  }

  /** Find a record by id across all shards (cheap scan; ids are unique). */
  async findRecord(id: string): Promise<{ record: MemoryRecord; shard: ShardRef } | null> {
    for (const shard of await this.listShards()) {
      const record = await this.readRecord(shard, id);
      if (record) return { record, shard };
    }
    return null;
  }

  async writeRecord(shard: ShardRef, record: MemoryRecord): Promise<void> {
    await ensureDir(this.shardDir(shard));
    await atomicWriteFile(this.recordPath(shard, record.id), serializeRecord(record));
    await this.upsertIndexLine(shard, record);
    await this.bumpSeq(shard.name);
  }

  /** Bulk write (import/migration): files first, index once, seq once. */
  async writeRecordsBulk(shard: ShardRef, records: MemoryRecord[]): Promise<void> {
    if (records.length === 0) return;
    await ensureDir(this.shardDir(shard));
    const CONCURRENCY = 32;
    for (let i = 0; i < records.length; i += CONCURRENCY) {
      const batch = records.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((record) => atomicWriteFile(this.recordPath(shard, record.id), serializeRecord(record))),
      );
    }
    await this.rebuildIndexFile(shard);
    await this.bumpSeq(shard.name);
  }

  /** Update MEMORY.md one line at a time (index is derived, safe to rebuild). */
  private async upsertIndexLine(shard: ShardRef, record: MemoryRecord): Promise<void> {
    const file = this.indexFile(shard);
    let lines: string[] = [];
    try {
      const raw = await fs.readFile(file, "utf8");
      lines = normalizeNewlines(raw).split("\n");
    } catch {
      lines = ["# Memory Index", "", "<!-- derived file, regenerated by `harnmem doctor --rebuild-index`; do not edit by hand -->", ""];
    }
    const { indexLine } = await import("./frontmatter.js");
    const line = indexLine(record);
    const needle = `(${recordFileName(record.id)})`;
    const idx = lines.findIndex((l) => l.includes(needle));
    if (idx >= 0) {
      if (record.status === "dropped" || record.status === "archived") lines.splice(idx, 1);
      else lines[idx] = line;
    } else if (record.status === "active") {
      const headerEnd = Math.max(0, lines.findIndex((l) => l.startsWith("<!--")) + 1);
      lines.splice(headerEnd, 0, line);
    } else {
      return;
    }
    await atomicWriteFile(file, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  }

  /** Move a record file to trash (soft delete for `forget`). */
  async moveToTrash(shard: ShardRef, record: MemoryRecord, now: number): Promise<string> {
    const src = this.recordPath(shard, record.id);
    const dest = join(this.trashDir, `${dayStamp(now)}-${record.id}.md`);
    await ensureDir(this.trashDir);
    try {
      await fs.rename(src, dest);
    } catch {
      await fs.copyFile(src, dest);
      await fs.unlink(src);
    }
    await this.upsertIndexLine(shard, { ...record, status: "dropped" });
    await this.bumpSeq(shard.name);
    return dest;
  }

  async getSeq(): Promise<number> {
    if (this.seqCache !== null) return this.seqCache;
    return this.peekSeq();
  }

  /**
   * Per-shard sequence: index validity is checked against it, so a write to one
   * project never invalidates unrelated shard indexes (global seq invalidates all).
   */
  async getShardSeq(name: string): Promise<number> {
    if (this.seqCache === null || this.shardSeqCache === null) await this.peekSeq();
    return this.shardSeqCache?.get(name) ?? 0;
  }

  /** Read the seq from disk, bypassing the in-process cache (cross-process freshness). */
  async peekSeq(): Promise<number> {
    const parsed = await readJson<{ seq?: number; shards?: Record<string, number> }>(this.path("state", "seq.json"), {
      seq: 0,
    });
    const seq = typeof parsed.seq === "number" ? parsed.seq : 0;
    this.seqCache = seq;
    this.shardSeqCache = new Map(Object.entries(parsed.shards ?? {}));
    return seq;
  }

  async bumpSeq(shardName?: string): Promise<number> {
    if (this.seqCache === null) await this.peekSeq();
    const next = (this.seqCache ?? 0) + 1;
    this.seqCache = next;
    if (shardName) {
      const current = this.shardSeqCache?.get(shardName) ?? 0;
      this.shardSeqCache?.set(shardName, current + 1);
    }
    const shards = this.shardSeqCache ? Object.fromEntries(this.shardSeqCache) : {};
    await writeJson(this.path("state", "seq.json"), { seq: next, shards });
    return next;
  }

  async audit(entry: Omit<AuditEntry, "seq"> & { seq?: number }): Promise<void> {
    const seq = entry.seq ?? (await this.getSeq());
    const line = JSON.stringify({ seq, ...entry });
    await ensureDir(this.stateDir);
    const file = this.path("state", "audit.jsonl");
    if (!(await pathExists(file))) {
      await atomicWriteFile(file, `${line}\n`);
      return;
    }
    const current = await fs.readFile(file, "utf8");
    await atomicWriteFile(file, `${current.replace(/\n+$/, "")}\n${line}\n`);
  }

  async getCursor(key: string): Promise<string | null> {
    const cursors = await readJson<Record<string, string>>(this.path("state", "cursors.json"), {});
    return cursors[key] ?? null;
  }

  async setCursor(key: string, value: string): Promise<void> {
    const cursors = await readJson<Record<string, string>>(this.path("state", "cursors.json"), {});
    cursors[key] = value;
    await writeJson(this.path("state", "cursors.json"), cursors);
  }

  private usageCache: Map<string, UsageEntry> | null = null;

  /**
   * Usage counters live in `state/usage.json`, not in the memory files: a search
   * touches up to `budget` records, and rewriting N markdown files per query
   * (plus invalidating every shard index) does not scale. Memory files stay the
   * SSOT for content; `doctor --merge-usage` folds these counters back into the
   * frontmatter when it matters.
   */
  async loadUsage(): Promise<Map<string, UsageEntry>> {
    if (this.usageCache) return this.usageCache;
    const raw = await readJson<Record<string, UsageEntry>>(this.path("state", "usage.json"), {});
    this.usageCache = new Map(Object.entries(raw));
    return this.usageCache;
  }

  /** Persist usage counters (lastUsed/usedCount) touched by searches. */
  async saveUsage(updates: Map<string, UsageEntry>): Promise<void> {
    if (updates.size === 0) return;
    const usage = await this.loadUsage();
    for (const [id, update] of updates) usage.set(id, update);
    await writeJson(this.path("state", "usage.json"), Object.fromEntries(usage));
  }

  /**
   * Session journal entry (only what extraction needs).
   *
   * Idempotent per message: re-persisting a snapshot that already covers
   * messages from an earlier process (the adapter rehydrates its digest from
   * this journal) appends only the lines that are not already present.
   */
  async appendSession(input: {
    harness: string;
    sessionId: string;
    cwd: string;
    date?: string;
    messages: { role: string; text: string; ts?: number }[];
  }): Promise<void> {
    const date = input.date ?? dayStamp(Date.now());
    const dir = this.path("sessions", date);
    await ensureDir(dir);
    const file = join(dir, `${input.harness}_${sanitizeFilePart(input.sessionId)}.jsonl`);
    const existing = (await pathExists(file)) ? await fs.readFile(file, "utf8") : "";
    const seen = new Set<string>();
    for (const rawLine of existing.split(/\r?\n/)) {
      // Tolerate a UTF-8 BOM from hand-edited / PowerShell-written journals.
      const line = rawLine.replace(/^\uFEFF/, "");
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { ts?: number; role?: string; text?: string };
        if (parsed.role && typeof parsed.text === "string") {
          seen.add(journalKey(parsed.ts, parsed.role, parsed.text));
        }
      } catch {
        // Ignore malformed journal lines; new messages are still appended.
      }
    }
    const fresh: string[] = [];
    for (const m of input.messages) {
      const ts = m.ts ?? Date.now();
      const key = journalKey(ts, m.role, m.text);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push(JSON.stringify({ ts, role: m.role, text: m.text.slice(0, 4096), cwd: input.cwd }));
    }
    if (fresh.length === 0) return;
    await atomicWriteFile(file, `${existing}${fresh.join("\n")}\n`);
  }

  /**
   * Read one session's persisted journal across day directories, oldest first,
   * deduplicated and bounded to the last 200 messages.
   *
   * DSH resumes a session in a new process without replaying earlier events, so
   * an adapter that only kept a process-local digest would always hit the
   * `too_few_messages` gate at the next quit. Adapters use this to rehydrate.
   */
  async readSessionTranscript(harness: string, sessionId: string): Promise<TranscriptMessage[]> {
    const root = this.path("sessions");
    let dates: string[] = [];
    try {
      dates = (await fs.readdir(root)).filter((name) => /^\d{8}$/.test(name)).sort();
    } catch {
      return [];
    }
    const file = `${harness}_${sanitizeFilePart(sessionId)}.jsonl`;
    const seen = new Set<string>();
    const out: TranscriptMessage[] = [];
    for (const date of dates) {
      const path = join(root, date, file);
      if (!(await pathExists(path))) continue;
      let raw = "";
      try {
        raw = await fs.readFile(path, "utf8");
      } catch {
        continue;
      }
      for (const rawLine of raw.split(/\r?\n/)) {
        // Tolerate a UTF-8 BOM from hand-edited / PowerShell-written journals.
        const line = rawLine.replace(/^\uFEFF/, "");
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { ts?: number; role?: string; text?: string };
          if (typeof parsed.text !== "string" || parsed.text.trim() === "") continue;
          const role = parsed.role;
          if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") continue;
          const key = journalKey(parsed.ts, role, parsed.text);
          if (seen.has(key)) continue;
          seen.add(key);
          const message: TranscriptMessage = { role, text: parsed.text };
          if (typeof parsed.ts === "number") message.ts = parsed.ts;
          out.push(message);
        } catch {
          // Ignore malformed journal lines.
        }
      }
    }
    out.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    return out.slice(-200);
  }

  async listDigests(shard: ShardRef): Promise<DigestEntry[]> {
    const dir = this.digestDir(shard);
    let files: string[] = [];
    try {
      files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md"));
    } catch {
      return [];
    }
    const out: DigestEntry[] = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(join(dir, file), "utf8");
        const parsed = parseFrontmatter(raw);
        const firstHeading = parsed.body.split("\n").find((l) => l.trim().startsWith("#"));
        out.push({
          name: file.replace(/\.md$/, ""),
          title: firstHeading ? firstHeading.replace(/^#+\s*/, "").trim() : file.replace(/\.md$/, ""),
          body: parsed.body.trim(),
          updated: typeof parsed.data["updated"] === "number" ? (parsed.data["updated"] as number) : undefined,
        });
      } catch {
        // skip unreadable digest
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Load/save per-shard search index JSON. */
  async loadIndex(name: string): Promise<unknown | null> {
    const file = this.path("index", `${sanitizeFilePart(name)}.json`);
    if (!(await pathExists(file))) return null;
    return readJson<unknown>(file, null);
  }

  async saveIndex(name: string, value: unknown): Promise<void> {
    await writeJson(this.path("index", `${sanitizeFilePart(name)}.json`), value);
  }

  async readManifest(): Promise<{ version: number; seq: number; shards: unknown[] } | null> {
    return readJson(this.path("index", "manifest.json"), null as null | { version: number; seq: number; shards: unknown[] });
  }

  async writeManifest(seq: number, shards: unknown[]): Promise<void> {
    await writeJson(this.path("index", "manifest.json"), { version: 1, seq, builtAt: Date.now(), shards });
  }

  /** Rebuild human-readable MEMORY.md for a shard from its files. */
  async rebuildIndexFile(shard: ShardRef): Promise<number> {
    const { records } = await this.readShard(shard);
    const { indexLine } = await import("./frontmatter.js");
    const active = records
      .filter((r) => r.status === "active")
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || b.updated - a.updated || a.id.localeCompare(b.id));
    const lines = [
      "# Memory Index",
      "",
      "<!-- derived file, regenerated by `harnmem doctor --rebuild-index`; do not edit by hand -->",
      "",
      ...active.map((r) => indexLine(r)),
    ];
    await atomicWriteFile(this.indexFile(shard), `${lines.join("\n")}\n`);
    return active.length;
  }

  async stats(): Promise<{
    memories: number;
    user: number;
    projects: Record<string, number>;
    archived: number;
    superseded: number;
    trash: number;
    digests: number;
  }> {
    let user = 0;
    let archived = 0;
    let superseded = 0;
    const projects: Record<string, number> = {};
    for (const shard of await this.listShards()) {
      const { records } = await this.readShard(shard);
      const active = records.filter((r) => r.status === "active").length;
      if (shard.scope === "user") user = active;
      else projects[shard.project as string] = active;
      archived += records.filter((r) => r.status === "archived").length;
      superseded += records.filter((r) => r.status === "superseded").length;
    }
    let trash = 0;
    try {
      trash = (await fs.readdir(this.trashDir)).filter((f) => f.endsWith(".md")).length;
    } catch {
      trash = 0;
    }
    let digests = 0;
    for (const shard of await this.listShards()) digests += (await this.listDigests(shard)).length;
    return {
      memories: user + Object.values(projects).reduce((a, b) => a + b, 0),
      user,
      projects,
      archived,
      superseded,
      trash,
      digests,
    };
  }
}

/** File-safe directory/filename component; pure-dot results ("..") collapse to "x". */
export function sanitizeFilePart(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80);
  return !cleaned || /^\.+$/.test(cleaned) ? "x" : cleaned;
}

/** Identity of a journal message: same ts+role+text = same append. */
function journalKey(ts: number | undefined, role: string, text: string): string {
  return `${ts ?? 0}\u0000${role}\u0000${text.slice(0, 200)}`;
}

function dayStamp(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}${`${d.getMonth() + 1}`.padStart(2, "0")}${`${d.getDate()}`.padStart(2, "0")}`;
}

export function shardKey(shard: ShardRef): string {
  return shard.name;
}

export function shardFromName(name: string): ShardRef {
  return name === "user" ? { scope: "user", name: "user" } : { scope: "project", project: name, name };
}

export { dirname };
