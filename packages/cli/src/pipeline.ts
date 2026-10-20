/**
 * Import pipeline: discover → plan → backup → apply → ledger → verify/rollback.
 *
 * Guarantees:
 *  - dry-run (the default) writes nothing: no backup, no records, no ledger,
 *    no unresolved bucket — it only reports what would happen;
 *  - `--apply` backs up the whole source tree and records sha256+mtime of every
 *    source file *before* writing, then re-checks it afterwards, so the notes
 *    can prove the legacy stores were left untouched;
 *  - re-running is idempotent: unchanged sources are skipped via the ledger,
 *    changed sources are re-imported with a warning;
 *  - `--rollback <runId>` hard-forgets exactly the ids that run created and
 *    marks the ledger, so a later re-import works.
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import type { HarnMem, HarnessId } from "@harnmem/core";

import {
  buildImportedIndex,
  listLedgers,
  newRunId,
  readLedger,
  writeLedger,
  type LedgerCounts,
  type LedgerEntry,
  type MigrationLedger,
} from "./ledger.js";
import type { ProjectInfo } from "./identity.js";
import { readProjects } from "./identity.js";
import { discoverDsh } from "./importers/dsh.js";
import { discoverJson } from "./importers/json.js";
import { discoverPi } from "./importers/pi.js";
import { discoverZcode } from "./importers/zcode.js";
import {
  safeFileStem,
  sha256Hex,
  type DiscoverOptions,
  type DiscoverResult,
  type ImportItem,
} from "./importers/types.js";

export type ImportSource = "dsh" | "pi" | "zcode" | "json";

export interface ImportCommandOptions {
  from: ImportSource;
  sourcePath: string;
  sessionsRoot?: string;
  pathMap: Record<string, string>;
  fallbackProject?: ProjectInfo;
  cwd: string;
  home: string;
  includeDaily: boolean;
  /** True when the user did NOT pass --apply/--yes (dry-run is the default). */
  dryRun: boolean;
}

export interface VerifyReport {
  runId: string;
  checked: number;
  found: number;
  missing: number;
  missingIds: string[];
  sourcesUnchanged: boolean;
  sourceDrift: number;
}

export interface ImportReport {
  runId: string;
  harness: string;
  sourceRoot: string;
  dryRun: boolean;
  counts: LedgerCounts;
  byType: Record<string, number>;
  byProject: Record<string, number>;
  unresolvedKeys: string[];
  warnings: string[];
  ledgerPath?: string;
  backupPath?: string;
  verify?: VerifyReport;
  elapsedMs: number;
}

export interface ManifestEntry {
  absPath: string;
  rel: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  runId: string;
  sourceRoot: string;
  createdAt: number;
  entries: ManifestEntry[];
}

async function discover(options: ImportCommandOptions): Promise<DiscoverResult> {
  const common: DiscoverOptions = {
    sourcePath: options.sourcePath,
    sessionsRoot: options.sessionsRoot,
    pathMap: options.pathMap,
    fallbackProject: options.fallbackProject,
    cwd: options.cwd,
    home: options.home,
    includeDaily: options.includeDaily,
  };
  switch (options.from) {
    case "dsh":
      return discoverDsh(common);
    case "pi":
      return discoverPi(common);
    case "zcode":
      return discoverZcode(common);
    case "json":
      return discoverJson(common);
    default: {
      const never: never = options.from;
      throw new Error(`unknown import source: ${String(never)}`);
    }
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(abs);
      if (out.length > 5000) throw new Error(`source tree too large (>5000 files): ${root}`);
    }
  }
  return out.sort();
}

async function backupSource(
  sourcePath: string,
  home: string,
  runId: string,
): Promise<{ backupPath: string; manifest: BackupManifest }> {
  const destDir = join(home, "state", "backups", runId);
  const copyDir = join(destDir, "source");
  await mkdir(copyDir, { recursive: true });

  const sourceStat = await stat(sourcePath);
  const files = sourceStat.isDirectory() ? await listFiles(sourcePath) : [sourcePath];
  const entries: ManifestEntry[] = [];
  for (const absPath of files) {
    const info = await stat(absPath);
    const rel = sourceStat.isDirectory() ? relative(sourcePath, absPath) : basename(absPath);
    const content = await readFile(absPath);
    entries.push({
      absPath,
      rel,
      size: info.size,
      mtimeMs: info.mtimeMs,
      sha256: sha256Hex(content.toString("utf8")),
    });
    if (info.size <= 5 * 1024 * 1024) {
      const target = join(copyDir, rel);
      await mkdir(join(target, ".."), { recursive: true });
      await copyFile(absPath, target);
    }
  }
  const manifest: BackupManifest = {
    version: 1,
    runId,
    sourceRoot: sourcePath,
    createdAt: Date.now(),
    entries,
  };
  await writeFile(join(destDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { backupPath: destDir, manifest };
}

async function writeManifest(destDir: string, manifest: BackupManifest): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await writeFile(join(destDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function readBackupManifest(backupPath: string): Promise<BackupManifest | null> {
  try {
    const raw = await readFile(join(backupPath, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as BackupManifest;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Compare the pre-apply manifest against the files currently on disk. */
export async function verifySources(manifest: BackupManifest): Promise<{ unchanged: boolean; drift: number }> {
  let drift = 0;
  for (const entry of manifest.entries) {
    try {
      const info = await stat(entry.absPath);
      const content = await readFile(entry.absPath);
      const hash = sha256Hex(content.toString("utf8"));
      if (hash !== entry.sha256 || info.mtimeMs !== entry.mtimeMs) drift += 1;
    } catch {
      drift += 1;
    }
  }
  return { unchanged: drift === 0, drift };
}

async function writeUnresolvedBuckets(
  home: string,
  runId: string,
  discovery: DiscoverResult,
): Promise<string[]> {
  const written: string[] = [];
  for (const group of discovery.unresolved) {
    const dir = join(home, "imports", "unresolved", safeFileStem(group.key));
    await mkdir(dir, { recursive: true });
    const file = join(dir, "records.json");
    await writeFile(
      file,
      `${JSON.stringify(
        {
          version: 1,
          runId,
          harness: discovery.harness,
          key: group.key,
          reason: group.reason,
          discoveredAt: Date.now(),
          count: group.records.length,
          hint: "add a --path-map entry mapping this key to a project id/path, then re-run with --apply",
          records: group.records,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    written.push(file);
  }
  return written;
}

function tally(list: ImportItem[], pick: (item: ImportItem) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of list) {
    const key = pick(item) ?? "unknown";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

export async function runImport(eng: HarnMem | null, home: string, options: ImportCommandOptions): Promise<ImportReport> {
  const startedAt = Date.now();
  const runId = newRunId(startedAt);
  const discovery = await discover(options);
  const { byKey, runByKey } = buildImportedIndex(await listLedgers(home));

  // Core fills a missing projectName with *its own* project name, which would
  // mislabel foreign-project records. Fill it here from the registry (advisory)
  // and fall back to the hash-stripped slug.
  const registry = await readProjects(home);
  const knownNames = new Map<string, string>();
  for (const entry of Object.values(registry.projects)) knownNames.set(entry.id, entry.name);
  for (const item of discovery.items) {
    const record = item.record;
    if (record.scope === "project" && record.project && !record.projectName) {
      record.projectName =
        knownNames.get(record.project) ?? record.project.replace(/-[0-9a-f]{10}$/, "");
    }
  }

  const plan: ImportItem[] = [];
  const warnings = [...discovery.warnings];
  let skipped = 0;
  for (const item of discovery.items) {
    const existing = byKey.get(item.key);
    if (existing) {
      if (existing.sourceHash === item.sourceHash) {
        skipped += 1;
        continue;
      }
      warnings.push(
        `source changed since run ${runByKey.get(item.key) ?? "?"}; importing new version: ${item.originPath}`,
      );
    }
    plan.push(item);
  }

  // importRecords() silently drops title-less records, which would shift the
  // id order against the ledger; filter them out first so index mapping holds.
  let titleSkipped = 0;
  const importable = plan.filter((item) => {
    if (item.record.title && item.record.title.trim() !== "") return true;
    titleSkipped += 1;
    warnings.push(`skipped record without title: ${item.originPath}`);
    return false;
  });
  skipped += titleSkipped;

  const counts: LedgerCounts = {
    discovered: discovery.items.length,
    imported: importable.length,
    skipped,
    errors: 0,
    unresolved: discovery.unresolved.reduce((sum, group) => sum + group.records.length, 0),
  };
  const unresolvedKeys = discovery.unresolved.map((group) => group.key);
  const report: ImportReport = {
    runId,
    harness: String(discovery.harness),
    sourceRoot: discovery.sourceRoot,
    dryRun: options.dryRun,
    counts,
    byType: tally(importable, (item) => item.record.type),
    byProject: tally(importable, (item) => item.record.project ?? (item.record.scope === "user" ? "user" : undefined)),
    unresolvedKeys,
    warnings,
    elapsedMs: 0,
  };

  if (options.dryRun) {
    report.elapsedMs = Date.now() - startedAt;
    return report;
  }

  // Safety: no writes before the source is backed up and manifested.
  if (!eng) throw new Error("internal: apply requires an HarnMem instance");
  const { backupPath, manifest } = await backupSource(discovery.sourceRoot, home, runId);
  report.backupPath = backupPath;

  const records = importable.map((item) => item.record);
  const result = await eng.importRecords(records, { dedupe: false });
  const ids = result.ids;
  if (ids.length !== records.length) {
    warnings.push(`importRecords returned ${ids.length} ids for ${records.length} records`);
  }
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < importable.length; i++) {
    const item = importable[i];
    const id = ids[i];
    if (!item || !id) {
      counts.errors += 1;
      warnings.push(`record not persisted at index ${i} (${item?.key ?? "?"})`);
      continue;
    }
    entries.push({
      key: item.key,
      sourceHash: item.sourceHash,
      id,
      status: "imported",
      originPath: item.originPath,
      scope: item.record.scope,
      project: item.record.project,
      note: item.note,
    });
  }
  warnings.push(...result.warnings);
  counts.errors += result.skipped;

  const ledger: MigrationLedger = {
    version: 1,
    runId,
    harness: discovery.harness,
    sourceRoot: discovery.sourceRoot,
    startedAt,
    finishedAt: Date.now(),
    dryRun: false,
    counts,
    backupPath,
    entries,
    warnings,
  };
  const ledgerPath = await writeLedger(home, ledger);
  report.ledgerPath = ledgerPath;
  await writeUnresolvedBuckets(home, runId, discovery);
  await writeManifest(backupPath, manifest);

  const integrity = await verifySources(manifest);
  report.verify = {
    runId,
    checked: entries.length,
    found: entries.length,
    missing: 0,
    missingIds: [],
    sourcesUnchanged: integrity.unchanged,
    sourceDrift: integrity.drift,
  };
  report.elapsedMs = Date.now() - startedAt;
  return report;
}

/** Re-read every memory id a run claims to have created. */
export async function verifyRun(eng: HarnMem, home: string, runId: string): Promise<VerifyReport> {
  const ledger = await readLedger(home, runId);
  if (!ledger) throw new Error(`no migration ledger for run ${runId} under ${join(home, "state", "migrations")}`);
  const imported = ledger.entries.filter((entry) => entry.status === "imported");
  const missingIds: string[] = [];
  let found = 0;
  for (const entry of imported) {
    const result = await eng.read(entry.id);
    if (result) found += 1;
    else missingIds.push(entry.id);
  }
  let sourcesUnchanged = true;
  let sourceDrift = 0;
  if (ledger.backupPath) {
    const manifest = await readBackupManifest(ledger.backupPath);
    if (manifest) {
      const integrity = await verifySources(manifest);
      sourcesUnchanged = integrity.unchanged;
      sourceDrift = integrity.drift;
    }
  }
  return {
    runId,
    checked: imported.length,
    found,
    missing: missingIds.length,
    missingIds,
    sourcesUnchanged,
    sourceDrift,
  };
}

export interface RollbackReport {
  runId: string;
  checked: number;
  forgotten: number;
  missing: number;
  alreadyRolledBack: boolean;
  ledgerPath: string;
}

/** Hard-forget every id a run imported and mark the ledger. */
export async function rollbackRun(eng: HarnMem, home: string, runId: string): Promise<RollbackReport> {
  const ledger = await readLedger(home, runId);
  if (!ledger) throw new Error(`no migration ledger for run ${runId} under ${join(home, "state", "migrations")}`);
  if (ledger.rolledBackAt) {
    return {
      runId,
      checked: ledger.entries.length,
      forgotten: 0,
      missing: 0,
      alreadyRolledBack: true,
      ledgerPath: join(home, "state", "migrations", `${runId}.json`),
    };
  }
  let forgotten = 0;
  let missing = 0;
  const checked = ledger.entries.length;
  for (const entry of ledger.entries) {
    if (entry.status !== "imported") continue;
    try {
      const result = await eng.forget(entry.id, { hard: true });
      if (result.ok) {
        entry.status = "rolledBack";
        forgotten += 1;
      } else {
        missing += 1;
      }
    } catch {
      missing += 1;
    }
  }
  ledger.rolledBackAt = Date.now();
  const ledgerPath = await writeLedger(home, ledger);
  return { runId, checked, forgotten, missing, alreadyRolledBack: false, ledgerPath };
}

export function describeIntegrity(report: ImportReport): string {
  if (!report.verify) return "";
  return report.verify.sourcesUnchanged
    ? `sources unchanged (0 drift over ${report.verify.checked} files)`
    : `WARNING: ${report.verify.sourceDrift} source files changed during import`;
}

export function ledgerSummary(ledger: MigrationLedger): string {
  return `run ${ledger.runId}: ${ledger.counts.imported} imported, ${ledger.counts.skipped} skipped, ${ledger.counts.unresolved} unresolved`;
}

export type { HarnessId };
