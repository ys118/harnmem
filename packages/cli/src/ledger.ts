/**
 * Migration ledger — the idempotency and rollback backbone of `harnmem import`.
 *
 * One JSON file per run under `<home>/state/migrations/<runId>.json`. Entries
 * are keyed by `harness|relativeOriginPath|originalId` and carry a content
 * hash, so a re-run is a no-op for unchanged sources and a warning for changed
 * ones. Rollback hard-forgets every id the run imported and marks the ledger.
 */

import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HarnessId, MemoryScope } from "@harnmem/core";

export type LedgerEntryStatus = "imported" | "rolledBack";

export interface LedgerEntry {
  /** Idempotency key: harness|relativeOriginPath|originalId. */
  key: string;
  /** SHA-256 of the canonical source record at import time. */
  sourceHash: string;
  /** HarnMem memory id that was created (empty for non-imported entries). */
  id: string;
  status: LedgerEntryStatus;
  /** Absolute path of the source file this record came from. */
  originPath: string;
  scope?: MemoryScope;
  project?: string;
  note?: string;
}

export interface LedgerCounts {
  discovered: number;
  imported: number;
  skipped: number;
  errors: number;
  unresolved: number;
}

export interface MigrationLedger {
  version: 1;
  runId: string;
  harness: HarnessId | "json";
  sourceRoot: string;
  startedAt: number;
  finishedAt?: number;
  dryRun: boolean;
  counts: LedgerCounts;
  backupPath?: string;
  entries: LedgerEntry[];
  warnings: string[];
  rolledBackAt?: number;
}

export function migrationsDir(home: string): string {
  return join(home, "state", "migrations");
}

export async function listLedgers(home: string): Promise<MigrationLedger[]> {
  const dir = migrationsDir(home);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const ledgers: MigrationLedger[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    try {
      const raw = await readFile(join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as MigrationLedger;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) ledgers.push(parsed);
    } catch {
      // tolerate a partially written ledger
    }
  }
  return ledgers;
}

export interface ImportedIndex {
  /** key → entry of the most recent non-rolled-back import. */
  byKey: Map<string, LedgerEntry>;
  /** runId by key, for reporting. */
  runByKey: Map<string, string>;
}

/** Merge every ledger's imported entries, newest run winning. */
export function buildImportedIndex(ledgers: MigrationLedger[]): ImportedIndex {
  const sorted = [...ledgers].sort((a, b) => a.startedAt - b.startedAt);
  const byKey = new Map<string, LedgerEntry>();
  const runByKey = new Map<string, string>();
  for (const ledger of sorted) {
    for (const entry of ledger.entries) {
      if (entry.status !== "imported") continue;
      byKey.set(entry.key, entry);
      runByKey.set(entry.key, ledger.runId);
    }
  }
  return { byKey, runByKey };
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

export async function writeLedger(home: string, ledger: MigrationLedger): Promise<string> {
  const dir = migrationsDir(home);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${ledger.runId}.json`);
  await atomicWriteJson(path, ledger);
  return path;
}

export async function readLedger(home: string, runId: string): Promise<MigrationLedger | null> {
  try {
    const raw = await readFile(join(migrationsDir(home), `${runId}.json`), "utf8");
    const parsed = JSON.parse(raw) as MigrationLedger;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function newRunId(now = Date.now()): string {
  const iso = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const rand = Math.random().toString(36).slice(2, 8);
  return `mig-${iso}-${rand}`;
}
