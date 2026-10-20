/**
 * Command implementations for the `harnmem` CLI.
 *
 * Every command opens the store through @harnmem/core's public facade
 * (`HarnMem.open`), never through internal modules. Commands return an exit
 * code; `main.ts` turns thrown errors into diagnostics.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { HarnMem } from "@harnmem/core";
import type {
  HarnessId,
  ImportRecord,
  MemoryScope,
  MemoryStatus,
  ReadResult,
  SearchOptions,
  SearchResult,
  Stats,
  WriteInput,
} from "@harnmem/core";

import { flagBool, flagString, flagList, flagNumber, type ParsedArgs, UsageError } from "./args.js";
import { fmArray, fmBoolean, fmNumber, fmString, parseFrontmatter, type FrontmatterValue } from "./frontmatter.js";
import { resolveProjectArgument } from "./identity.js";
import { listLedgers, readLedger } from "./ledger.js";
import { Output, formatBytes, formatHit, pad, shortDate } from "./output.js";
import {
  describeIntegrity,
  readBackupManifest,
  rollbackRun,
  runImport,
  verifyRun,
  type ImportCommandOptions,
  type ImportReport,
  type ImportSource,
} from "./pipeline.js";
import { asMemoryType, type DiscoverOptions } from "./importers/types.js";

export const EXIT = { OK: 0, FAIL: 1, USAGE: 2 } as const;

export const VERSION = "0.1.0";

// ------------------------------------------------------------------ env/home

/** Expand a leading `~` (the CLI must not depend on shell expansion). */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveHomeFlag(parsed: ParsedArgs): string {
  const raw = flagString(parsed, "home") ?? process.env.HARNMEM_HOME;
  return raw ? resolve(expandHome(raw)) : join(homedir(), ".harnmem");
}

function dshHome(): string {
  const raw = process.env.DSH_HOME;
  return raw ? resolve(expandHome(raw)) : join(homedir(), ".dsh");
}

function piAgentDir(): string {
  const raw = process.env.PI_AGENT_DIR;
  return raw ? resolve(expandHome(raw)) : join(homedir(), ".pi", "agent");
}

function zcodeHome(): string {
  const raw = process.env.ZCODE_HOME;
  return raw ? resolve(expandHome(raw)) : join(homedir(), ".zcode");
}

// ------------------------------------------------------------------ helpers

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * `--path-map` accepts both forms:
 *   --path-map key=projectIdOrPath        (repeatable)
 *   --path-map map.json                   ({"key": "id-or-path"} or {"map": {...}})
 */
async function resolvePathMaps(values: string[], cwd: string): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const value of values) {
    if (value.includes("=")) {
      const eq = value.indexOf("=");
      if (eq <= 0 || eq === value.length - 1) {
        throw new UsageError(`--path-map expects key=projectIdOrPath (got "${value}")`);
      }
      map[value.slice(0, eq).trim()] = value.slice(eq + 1).trim();
      continue;
    }
    const file = resolveInputPath(value, cwd);
    if (!file || !existsSync(file)) {
      throw new UsageError(`--path-map expects key=projectIdOrPath or an existing JSON file (got "${value}")`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    } catch (err) {
      throw new UsageError(`--path-map: cannot parse ${file}: ${(err as Error).message}`);
    }
    const source = parsed && typeof parsed === "object" && "map" in parsed ? (parsed as { map?: unknown }).map : parsed;
    if (!source || typeof source !== "object") {
      throw new UsageError(`--path-map: ${file} must be a JSON object mapping legacy keys to project ids or paths`);
    }
    for (const [key, target] of Object.entries(source as Record<string, unknown>)) {
      if (typeof target === "string" && key.trim()) map[key.trim()] = target.trim();
    }
  }
  return map;
}

function requireId(parsed: ParsedArgs, what = "memory id"): string {
  const id = parsed.positionals[0];
  if (!id) throw new UsageError(`missing ${what} (e.g. harnmem read mem_0123456789abcdefghijklmnop)`);
  return id;
}

/** Detect the project for a cwd without opening the store. */
async function currentProjectId(parsed: ParsedArgs, home: string, cwd: string): Promise<string | undefined> {
  const raw = flagString(parsed, "project");
  if (!raw) return undefined;
  const info = await resolveProjectArgument(home, raw, cwd);
  return info.id;
}

async function openHarnMem(parsed: ParsedArgs, home: string, cwd: string, harness: HarnessId = "cli"): Promise<HarnMem> {
  const projectId = await currentProjectId(parsed, home, cwd);
  return HarnMem.open({ harness, home, cwd: resolve(cwd), project: projectId });
}

async function withHarnMem(
  parsed: ParsedArgs,
  home: string,
  cwd: string,
  fn: (eng: HarnMem) => Promise<number>,
): Promise<number> {
  const eng = await openHarnMem(parsed, home, cwd);
  try {
    return await fn(eng);
  } finally {
    await eng.close();
  }
}

// ------------------------------------------------------------------ stats

export async function cmdStats(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  return withHarnMem(parsed, home, cwd, async (eng) => {
    const stats: Stats = await eng.stats();
    if (out.json) {
      out.data(stats);
      return EXIT.OK;
    }
    out.line(`${out.paint("harnmem", "bold")} ${VERSION} — ${stats.home}`);
    out.line(`project  ${stats.project}`);
    out.line(
      `index    seq ${stats.index.seq}, built ${shortDate(stats.index.builtAt)}, ` +
        `${stats.index.stale ? out.paint("STALE", "yellow") : "fresh"}, ${formatBytes(stats.index.sizeBytes)} ` +
        `(overhead ${(stats.index.overhead * 100).toFixed(0)}%)`,
    );
    out.line("");
    out.line(out.paint("scope     total  active  archived  pinned   bytes", "bold"));
    for (const shard of stats.shards) {
      const scope = shard.scope === "user" ? "user" : `project:${shard.name}`;
      out.line(
        `${pad(scope, 30)} ${pad(String(shard.total), 6)} ${pad(String(shard.active), 7)} ` +
          `${pad(String(shard.archived), 8)} ${pad(String(shard.pinned), 6)} ${formatBytes(shard.bytes)}`,
      );
    }
    out.line("");
    out.line(
      `health   duplicate candidates ${stats.health.duplicateCandidates}, orphans ${stats.health.orphans}, ` +
        `last consolidate ${stats.health.lastConsolidate ? shortDate(stats.health.lastConsolidate) : "never"}`,
    );
    const skipReasons = Object.entries(stats.extraction.skipReasons);
    out.line(
      `extract  pending ${stats.extraction.pending}, failed ${stats.extraction.failed}` +
        (skipReasons.length > 0 ? `, skips: ${skipReasons.map(([reason, n]) => `${reason}=${n}`).join(", ")}` : ""),
    );
    return EXIT.OK;
  });
}

// ------------------------------------------------------------------ search

export async function cmdSearch(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  const query = parsed.positionals.join(" ").trim();
  if (!query) throw new UsageError('search requires a query: harnmem search "deployment rule"');
  const scopeRaw = flagString(parsed, "scope") ?? "all";
  if (!["all", "user", "project"].includes(scopeRaw)) {
    throw new UsageError(`--scope must be user|project|all (got "${scopeRaw}")`);
  }
  const project = await currentProjectId(parsed, home, cwd);
  const opts: SearchOptions = {
    query,
    limit: flagNumber(parsed, "limit"),
    scope: scopeRaw as MemoryScope | "all",
    project,
    includeArchived: flagBool(parsed, "include-archived"),
    includeHistory: flagBool(parsed, "history"),
    asOf: flagString(parsed, "as-of"),
    entity: flagString(parsed, "entity"),
    debug: flagBool(parsed, "debug"),
  };
  return withHarnMem(parsed, home, cwd, async (eng) => {
    const started = Date.now();
    const result: SearchResult = await eng.search(opts);
    if (out.json) {
      out.data(result);
      return EXIT.OK;
    }
    if (result.abstained) {
      out.line(`no confident matches for "${query}" (abstained)`);
      return EXIT.OK;
    }
    out.line(
      `${result.results.length} of ${result.total} matches for "${query}" (${Date.now() - started}ms)` +
        (result.debug ? `, candidates ${result.debug.candidateCount}, shards ${result.debug.shards.join(",")}` : ""),
    );
    for (const hit of result.results) {
      out.line(formatHit(hit));
      if (hit.snippet) out.line(`    ${hit.snippet.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    return EXIT.OK;
  });
}

// ------------------------------------------------------------------ read

export async function cmdRead(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  const id = requireId(parsed);
  const opts = { includeHistory: flagBool(parsed, "history"), asOf: flagString(parsed, "as-of") };
  return withHarnMem(parsed, home, cwd, async (eng) => {
    const result: ReadResult | null = await eng.read(id, opts);
    if (out.json) {
      out.data(result);
      return result ? EXIT.OK : EXIT.FAIL;
    }
    if (!result) {
      out.error(`no such memory: ${id}`);
      return EXIT.FAIL;
    }
    const r = result.record;
    out.line(out.paint(`${r.id}  ${r.title}`, "bold"));
    out.line(
      `type ${r.type}${r.category ? `/${r.category}` : ""}  scope ${r.scope}` +
        (r.project ? ` (${r.project}${r.projectName ? ", " + r.projectName : ""})` : ""),
    );
    out.line(
      `status ${r.status}${r.pinned ? " pinned" : ""}  importance ${r.importance}  confidence ${r.confidence}` +
        `${r.sensitive ? "  " + out.paint("sensitive", "yellow") : ""}`,
    );
    out.line(`created ${shortDate(r.created)}  updated ${shortDate(r.updated)}  used ${r.usedCount}x`);
    if (r.tags.length > 0) out.line(`tags ${r.tags.join(", ")}`);
    if (r.links.length > 0) out.line(`links ${r.links.join(", ")}`);
    out.line(
      `source ${r.source.harness}${r.source.session ? ` session ${r.source.session}` : ""}` +
        `${r.source.turn !== undefined ? ` turn ${r.source.turn}` : ""}`,
    );
    if (r.provenance.length > 0) out.line(`provenance ${r.provenance.join(" → ")}`);
    if (r.description) {
      out.line("");
      out.line(`description: ${r.description}`);
    }
    out.line("");
    out.line(r.content);
    if (result.backlinks.length > 0) {
      out.line("");
      out.line(`backlinks: ${result.backlinks.join(", ")}`);
    }
    if (result.history && result.history.length > 0) {
      out.line("history:");
      for (const version of result.history) {
        out.line(`  - ${version.id} ${version.title} (${version.status}, ${shortDate(version.updated)})`);
      }
    }
    return EXIT.OK;
  });
}

// ------------------------------------------------------------------ write

export async function cmdWrite(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  const type = flagString(parsed, "type");
  if (!type) throw new UsageError("write requires --type user|feedback|project|reference");
  const title = flagString(parsed, "title");
  if (!title) throw new UsageError("write requires --title");
  const contentFile = flagString(parsed, "content-file");
  const content = contentFile ? await readIfExists(resolve(cwd, contentFile)) : flagString(parsed, "content");
  if (!content) throw new UsageError("write requires --content \"...\" or --content-file <path>");
  const scopeRaw = flagString(parsed, "scope");
  if (scopeRaw !== undefined && scopeRaw !== "user" && scopeRaw !== "project") {
    throw new UsageError(`--scope must be user|project (got "${scopeRaw}")`);
  }
  const project = await currentProjectId(parsed, home, cwd);
  const input: WriteInput = {
    type: asMemoryType(type),
    category: flagString(parsed, "category"),
    scope: scopeRaw,
    project,
    title,
    description: flagString(parsed, "description") ?? deriveDescription(content, title),
    content,
    tags: splitList(flagString(parsed, "tags")),
    entities: flagList(parsed, "entity"),
    importance: flagNumber(parsed, "importance"),
    confidence: flagNumber(parsed, "confidence"),
    pinned: flagBool(parsed, "pinned") || undefined,
    links: flagList(parsed, "link"),
    supersedes: flagList(parsed, "supersedes"),
    sensitive: flagBool(parsed, "sensitive") || undefined,
  };
  return withHarnMem(parsed, home, cwd, async (eng) => {
    const result = await eng.write(input);
    if (out.json) {
      out.data(result);
      return EXIT.OK;
    }
    out.line(`stored ${result.id} (${result.action})`);
    for (const warning of result.warnings) out.warn(warning);
    return EXIT.OK;
  });
}

/** First substantive line, used when --description is omitted (core requires one). */
function deriveDescription(content: string, title: string): string {
  const line =
    content
      .split(/\r?\n/)
      .map((part) => part.replace(/^#{1,6}\s*/, "").trim())
      .find((part) => part.length > 0) ?? title;
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`;
}

// ------------------------------------------------------------------ forget / restore

export async function cmdForget(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  const id = requireId(parsed);
  return withHarnMem(parsed, home, cwd, async (eng) => {
    const result = await eng.forget(id, { hard: flagBool(parsed, "hard") });
    if (out.json) {
      out.data(result);
      return result.ok ? EXIT.OK : EXIT.FAIL;
    }
    if (!result.ok) {
      out.error(`no such memory: ${id}`);
      return EXIT.FAIL;
    }
    out.line(`forgotten ${id} (${result.mode})`);
    return EXIT.OK;
  });
}

export async function cmdRestore(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  const id = requireId(parsed);
  return withHarnMem(parsed, home, cwd, async (eng) => {
    const result = await eng.restore(id);
    if (out.json) {
      out.data(result);
      return result.ok ? EXIT.OK : EXIT.FAIL;
    }
    if (!result.ok) {
      out.error(`nothing to restore for ${id} (not in trash)`);
      return EXIT.FAIL;
    }
    out.line(`restored ${id}`);
    return EXIT.OK;
  });
}

// ------------------------------------------------------------------ consolidate / rebuild

export async function cmdConsolidate(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  return withHarnMem(parsed, home, cwd, async (eng) => {
    const report = await eng.consolidate({
      dryRun: flagBool(parsed, "dry-run"),
      mechanicalOnly: flagBool(parsed, "mechanical-only"),
      maxLlmCalls: flagNumber(parsed, "max-llm-calls"),
    });
    if (out.json) {
      out.data(report);
      return EXIT.OK;
    }
    out.line(
      `consolidate ${report.runId}${report.dryRun ? " (dry-run)" : ""}: merged ${report.merged.length}, ` +
        `chains compressed ${report.supersededChainsCompressed}, archived ${report.archived.length}, ` +
        `digests ${report.digestsWritten.length}, llm calls ${report.llmCalls}, skipped ${report.skipped}`,
    );
    for (const merge of report.merged) {
      out.line(`  merged ${merge.into} ← ${merge.from.join(", ")}`);
    }
    return EXIT.OK;
  });
}

export async function cmdRebuild(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  return withHarnMem(parsed, home, cwd, async (eng) => {
    await eng.rebuildIndex();
    if (out.json) out.data({ ok: true });
    else out.line("index rebuilt");
    return EXIT.OK;
  });
}

// ------------------------------------------------------------------ export

const SNAKE_FIELDS = new Set([
  "schema",
  "id",
  "type",
  "category",
  "scope",
  "project",
  "project_name",
  "title",
  "description",
  "tags",
  "entities",
  "importance",
  "confidence",
  "pinned",
  "status",
  "created",
  "updated",
  "last_used",
  "used_count",
  "valid_from",
  "valid_to",
  "observed_at",
  "evidence",
  "source",
  "provenance",
  "links",
  "supersedes",
  "superseded_by",
  "sensitive",
  "migrated_from",
]);

function sourceObject(data: Record<string, FrontmatterValue>): Record<string, unknown> {
  const raw = data["source"];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** A stored memory file mapped back to an ImportRecord (exact inverse of core's serializer). */
function recordToImport(data: Record<string, FrontmatterValue>, body: string, fallbackId: string): ImportRecord {
  const sourceRaw = sourceObject(data);
  const migratedRaw = data["migrated_from"] ?? sourceRaw["migrated_from"];
  const migrated =
    migratedRaw && typeof migratedRaw === "object" && !Array.isArray(migratedRaw)
      ? {
          system: String((migratedRaw as Record<string, unknown>)["system"] ?? "unknown"),
          path: typeof (migratedRaw as Record<string, unknown>)["path"] === "string" ? ((migratedRaw as Record<string, unknown>)["path"] as string) : undefined,
          originalId:
            typeof (migratedRaw as Record<string, unknown>)["original_id"] === "string"
              ? ((migratedRaw as Record<string, unknown>)["original_id"] as string)
              : typeof (migratedRaw as Record<string, unknown>)["originalId"] === "string"
                ? ((migratedRaw as Record<string, unknown>)["originalId"] as string)
                : undefined,
        }
      : undefined;
  const scope = fmString(data, "scope") === "user" ? "user" : "project";
  const statusRaw = fmString(data, "status");
  const validToRaw = data["valid_to"];
  return {
    id: fmString(data, "id") ?? fallbackId,
    type: asMemoryType(fmString(data, "type")),
    category: fmString(data, "category"),
    scope,
    project: fmString(data, "project"),
    projectName: fmString(data, "project_name"),
    title: fmString(data, "title") ?? "(untitled)",
    description: fmString(data, "description") ?? "",
    content: body.trimEnd(),
    tags: fmArray(data, "tags"),
    entities: fmArray(data, "entities"),
    importance: fmNumber(data, "importance"),
    confidence: fmNumber(data, "confidence"),
    pinned: fmBoolean(data, "pinned"),
    status: (statusRaw as MemoryStatus | undefined) ?? "active",
    created: fmNumber(data, "created"),
    updated: fmNumber(data, "updated"),
    lastUsed: fmNumber(data, "last_used"),
    usedCount: fmNumber(data, "used_count"),
    validFrom: fmNumber(data, "valid_from"),
    validTo: validToRaw === null || validToRaw === undefined ? null : fmNumber(data, "valid_to"),
    observedAt: fmNumber(data, "observed_at"),
    evidence: fmNumber(data, "evidence"),
    source: {
      harness: (typeof sourceRaw["harness"] === "string" ? (sourceRaw["harness"] as string) : "unknown") as HarnessId,
      session: typeof sourceRaw["session"] === "string" ? (sourceRaw["session"] as string) : undefined,
      turn: typeof sourceRaw["turn"] === "number" ? (sourceRaw["turn"] as number) : undefined,
      ts: typeof sourceRaw["ts"] === "number" ? (sourceRaw["ts"] as number) : undefined,
      migratedFrom: migrated,
    },
    provenance: fmArray(data, "provenance"),
    links: fmArray(data, "links"),
    supersedes: fmArray(data, "supersedes"),
    supersededBy: fmString(data, "superseded_by") ?? null,
    sensitive: fmBoolean(data, "sensitive"),
  };
}

async function walkMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  let names: Array<import("node:fs").Dirent>;
  try {
    names = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of names) {
    const abs = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walkMarkdown(abs)));
    else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MEMORY.md") out.push(abs);
  }
  return out.sort();
}

/** Read every stored memory back out as ImportRecord[] (backup / migration exit). */
export async function exportRecords(home: string): Promise<ImportRecord[]> {
  const files = await walkMarkdown(join(home, "memories"));
  const records: ImportRecord[] = [];
  for (const file of files) {
    const raw = await readIfExists(file);
    if (!raw) continue;
    const parsed = parseFrontmatter(raw);
    const fallbackId = basename(file, ".md");
    const data: Record<string, FrontmatterValue> = { ...parsed.data };
    for (const key of Object.keys(data)) {
      if (!SNAKE_FIELDS.has(key)) delete data[key];
    }
    records.push(recordToImport(data, parsed.body, fallbackId));
  }
  records.sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || String(a.id).localeCompare(String(b.id)));
  return records;
}

export async function cmdExport(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  const records = await exportRecords(home);
  const envelope = {
    version: 1,
    kind: "harnmem-export",
    exportedAt: Date.now(),
    count: records.length,
    records,
  };
  const target = flagString(parsed, "out");
  if (target) {
    const file = resolve(cwd, target);
    await writeFile(file, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    if (out.json) out.data({ ok: true, file, count: records.length });
    else out.line(`exported ${records.length} records to ${file}`);
  } else {
    out.line(JSON.stringify(envelope, null, 2));
  }
  return EXIT.OK;
}

// ------------------------------------------------------------------ import

export const IMPORT_SOURCES: ImportSource[] = ["dsh", "pi", "zcode", "json"];
export const IMPORT_SUBCOMMANDS = [...IMPORT_SOURCES, "verify", "rollback", "list", "unresolved"] as const;

function resolveInputPath(raw: string | undefined, cwd: string): string | undefined {
  return raw ? resolve(cwd, expandHome(raw)) : undefined;
}

function defaultSourcePath(source: ImportSource): string {
  switch (source) {
    case "dsh":
      return join(dshHome(), "memory");
    case "pi":
      return join(piAgentDir(), "memory");
    case "zcode":
      return join(zcodeHome(), "cli");
    case "json":
      return "";
    default:
      return "";
  }
}

function defaultSessionsRoot(source: ImportSource): string | undefined {
  switch (source) {
    case "dsh":
      return join(dshHome(), "sessions");
    case "pi":
      return join(piAgentDir(), "sessions");
    default:
      return undefined;
  }
}

function printImportReport(out: Output, report: ImportReport): void {
  if (out.json) {
    out.data(report);
    return;
  }
  out.line(
    out.paint(
      report.dryRun ? "dry-run (no writes; pass --apply to import)" : "applied",
      report.dryRun ? "yellow" : "green",
    ) + `  run ${report.runId}`,
  );
  out.line(`source    ${report.sourceRoot} (${report.harness})`);
  out.line(
    `discovered ${report.counts.discovered} → import ${report.counts.imported}, ` +
      `skipped ${report.counts.skipped}, unresolved ${report.counts.unresolved}, errors ${report.counts.errors}`,
  );
  const typeLine = Object.entries(report.byType)
    .map(([key, n]) => `${key} ${n}`)
    .join(", ");
  if (typeLine) out.line(`by type   ${typeLine}`);
  const projectLine = Object.entries(report.byProject)
    .map(([key, n]) => `${key} ${n}`)
    .join(", ");
  if (projectLine) out.line(`by project ${projectLine}`);
  if (report.unresolvedKeys.length > 0) {
    out.line(`unresolved keys (see \`harnmem import unresolved\`): ${report.unresolvedKeys.join(", ")}`);
  }
  for (const warning of report.warnings) out.warn(warning);
  if (!report.dryRun) {
    if (report.ledgerPath) out.line(`ledger    ${report.ledgerPath}`);
    if (report.backupPath) out.line(`backup    ${report.backupPath}`);
    if (report.verify) {
      out.line(
        `verify    ${report.verify.found}/${report.verify.checked} ids present, ${describeIntegrity(report)}`,
      );
    } else {
      out.line(`verify    ${describeIntegrity(report)}`);
    }
  }
  out.line(`elapsed   ${report.elapsedMs}ms`);
}

function resolveSourcePath(source: ImportSource, parsed: ParsedArgs, cwd: string): string {
  const explicit = resolveInputPath(flagString(parsed, "path"), cwd);
  if (explicit) return explicit;
  if (source === "json") throw new UsageError("import --from json requires --path <file.json>");
  const fallback = defaultSourcePath(source);
  if (!existsSync(fallback)) {
    throw new UsageError(`source not found: ${fallback} (pass --path <dir>)`);
  }
  return fallback;
}

async function cmdImportSource(
  source: ImportSource,
  parsed: ParsedArgs,
  out: Output,
  home: string,
  cwd: string,
): Promise<number> {
  const sourcePath = resolveSourcePath(source, parsed, cwd);
  const sessionsRoot =
    resolveInputPath(flagString(parsed, "sessions"), cwd) ??
    (flagString(parsed, "sessions") === undefined ? defaultSessionsRoot(source) : undefined);
  const fallbackProjectRaw = flagString(parsed, "project");
  const fallbackProject = fallbackProjectRaw
    ? await resolveProjectArgument(home, fallbackProjectRaw, cwd)
    : undefined;
  const dryRun = !(flagBool(parsed, "apply") || flagBool(parsed, "yes"));
  const options: ImportCommandOptions = {
    from: source,
    sourcePath,
    sessionsRoot,
    pathMap: await resolvePathMaps(flagList(parsed, "path-map"), cwd),
    fallbackProject,
    cwd,
    home,
    includeDaily: !flagBool(parsed, "skip-daily"),
    dryRun,
  };
  const eng = dryRun ? null : await openHarnMem(parsed, home, cwd);
  try {
    const report = await runImport(eng, home, options);
    if (!dryRun && eng && flagBool(parsed, "verify")) {
      report.verify = await verifyRun(eng, home, report.runId);
    }
    printImportReport(out, report);
    if (dryRun) return EXIT.OK;
    if (report.counts.errors > 0) return EXIT.FAIL;
    if (report.verify && (!report.verify.sourcesUnchanged || report.verify.missing > 0)) return EXIT.FAIL;
    return EXIT.OK;
  } finally {
    if (eng) await eng.close();
  }
}

async function latestRunId(home: string): Promise<string> {
  const ledgers = await listLedgers(home);
  const last = ledgers.sort((a, b) => a.startedAt - b.startedAt).pop();
  if (!last) throw new UsageError("no migration runs recorded yet (run `harnmem import dsh --apply` first)");
  return last.runId;
}

async function cmdImportVerify(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  const runId = parsed.positionals[0] ?? (await latestRunId(home));
  const eng = await openHarnMem(parsed, home, cwd);
  try {
    const report = await verifyRun(eng, home, runId);
    if (out.json) {
      out.data(report);
    } else {
      out.line(`verify ${report.runId}: ${report.found}/${report.checked} ids present` + (report.missing > 0 ? `, ${report.missing} MISSING` : ""));
      if (report.missingIds.length > 0) out.line(`  missing: ${report.missingIds.join(", ")}`);
      out.line(
        report.sourcesUnchanged
          ? "sources unchanged since backup"
          : `WARNING: ${report.sourceDrift} source files changed since backup`,
      );
    }
    return report.missing === 0 && report.sourcesUnchanged ? EXIT.OK : EXIT.FAIL;
  } finally {
    await eng.close();
  }
}

async function cmdImportRollback(
  parsed: ParsedArgs,
  out: Output,
  home: string,
  cwd: string,
  runIdOverride?: string,
): Promise<number> {
  const runId = runIdOverride ?? parsed.positionals[0] ?? (await latestRunId(home));
  const eng = await openHarnMem(parsed, home, cwd);
  try {
    const report = await rollbackRun(eng, home, runId);
    if (out.json) out.data(report);
    else if (report.alreadyRolledBack) out.line(`run ${report.runId} was already rolled back (${report.ledgerPath})`);
    else out.line(`rolled back ${report.runId}: ${report.forgotten} forgotten, ${report.missing} missing (${report.ledgerPath})`);
    return report.alreadyRolledBack || report.missing === 0 ? EXIT.OK : EXIT.FAIL;
  } finally {
    await eng.close();
  }
}

async function cmdImportList(out: Output, home: string): Promise<number> {
  const ledgers = (await listLedgers(home)).sort((a, b) => a.startedAt - b.startedAt);
  if (out.json) {
    out.data(ledgers.map((ledger) => ({
      runId: ledger.runId,
      harness: ledger.harness,
      sourceRoot: ledger.sourceRoot,
      startedAt: ledger.startedAt,
      dryRun: ledger.dryRun,
      counts: ledger.counts,
      rolledBackAt: ledger.rolledBackAt,
    })));
    return EXIT.OK;
  }
  if (ledgers.length === 0) {
    out.line("no migration runs recorded");
    return EXIT.OK;
  }
  out.line(out.paint("runId                              harness  imported  skipped  unresolved  rolledBack", "bold"));
  for (const ledger of ledgers) {
    out.line(
      `${pad(ledger.runId, 34)} ${pad(String(ledger.harness), 8)} ${pad(String(ledger.counts.imported), 8)} ` +
        `${pad(String(ledger.counts.skipped), 8)} ${pad(String(ledger.counts.unresolved), 10)} ` +
        (ledger.rolledBackAt ? "yes" : "no"),
    );
  }
  return EXIT.OK;
}

async function cmdImportUnresolved(out: Output, home: string): Promise<number> {
  const root = join(home, "imports", "unresolved");
  let names: string[] = [];
  try {
    names = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    names = [];
  }
  const buckets: Array<{ dir: string; key: string; count: number }> = [];
  for (const name of names.sort()) {
    const dir = join(root, name);
    const raw = await readIfExists(join(dir, "records.json"));
    let count = 0;
    try {
      count = raw ? ((JSON.parse(raw) as { count?: number }).count ?? 0) : 0;
    } catch {
      count = 0;
    }
    buckets.push({ dir, key: name, count });
  }
  if (out.json) {
    out.data(buckets);
    return EXIT.OK;
  }
  if (buckets.length === 0) {
    out.line("no unresolved buckets — every record was attributable");
    return EXIT.OK;
  }
  for (const bucket of buckets) out.line(`${pad(bucket.key, 40)} ${bucket.count} records  ${bucket.dir}`);
  return EXIT.OK;
}

export async function cmdImport(parsed: ParsedArgs, out: Output, home: string, cwd: string): Promise<number> {
  const rollbackId = flagString(parsed, "rollback");
  if (rollbackId) return cmdImportRollback(parsed, out, home, cwd, rollbackId);
  const sub = parsed.subcommand ?? flagString(parsed, "from");
  if (!sub || sub === "help") {
    if (flagBool(parsed, "verify")) return cmdImportVerify(parsed, out, home, cwd);
    return cmdImportHelp(out);
  }
  switch (sub) {
    case "dsh":
    case "pi":
    case "zcode":
    case "json":
      return cmdImportSource(sub, parsed, out, home, cwd);
    case "verify":
      return cmdImportVerify(parsed, out, home, cwd);
    case "rollback":
      return cmdImportRollback(parsed, out, home, cwd);
    case "list":
      return cmdImportList(out, home);
    case "unresolved":
      return cmdImportUnresolved(out, home);
    default:
      throw new UsageError(`unknown import subcommand "${sub}" (expected ${IMPORT_SUBCOMMANDS.join("|")})`);
  }
}

export function cmdImportHelp(out: Output): number {
  out.line(`harnmem import — migrate legacy memory stores into ~/.harnmem

sources:
  harnmem import dsh  [--path <dir>] [--sessions <dir>] [--path-map key=id|path | map.json] [--apply]
  harnmem import pi   [--path <dir>] [--sessions <dir>] [--skip-daily] [--apply]
  harnmem import zcode [--path <dir>] [--apply]
  harnmem import json --path <file.json> [--apply]     # ImportRecord[] round-trip

equivalent long form (same flags):
  harnmem import --from dsh|pi|zcode|json --path <dir|file> [--dry-run] [--apply]
                [--path-map <file.json>|key=id|path] [--project <id|path>] [--verify]

inspection:
  harnmem import list                 # every recorded migration run
  harnmem import verify [runId]       # re-read ids + check sources untouched
  harnmem import --verify [runId]     # same, long form
  harnmem import rollback [runId]     # hard-forget ids from one run
  harnmem import --rollback <runId>   # same, long form
  harnmem import unresolved           # buckets that could not be attributed

defaults: ~/.dsh/memory + ~/.dsh/sessions, ~/.pi/agent/memory + sessions,
          ~/.zcode/cli (ZCode stores are optional; absent = skipped)
dry-run is the default; --apply backs up the source, writes a ledger and
verifies source mtimes/hashes afterwards. --path-map values may be a project
id already registered in <home>/projects.json or an existing directory path.`);
  return EXIT.OK;
}

// ------------------------------------------------------------------ help

export function printMainHelp(out: Output): number {
  out.line(`harnmem ${VERSION} — local, cross-harness agent memory (~/.harnmem)

usage: harnmem <command> [options]

commands:
  stats                       store/index/health summary
  search <query>              ranked memory search
  read <id>                   one memory (--history, --as-of <date>)
  write --type <t> --title <s> [--content <s>|--content-file <f>]
  forget <id> [--hard]        move to trash (or delete immediately)
  restore <id>                restore from trash
  consolidate [--dry-run] [--mechanical-only]
  rebuild | index rebuild      rebuild the search index
  export [--out <file>]       dump every memory as ImportRecord[]
  import <source|sub>         migrate legacy stores (see: harnmem import help)

global flags: --home <dir>  --cwd <dir>  --project <id|path>  --json  --no-color
              --help   --version

home: HARNMEM_HOME or ~/.harnmem`);
  return EXIT.OK;
}

export function cmdHelp(parsed: ParsedArgs, out: Output): number {
  const command = parsed.command;
  if (command === "import") return cmdImportHelp(out);
  return printMainHelp(out);
}

export type { DiscoverOptions };
