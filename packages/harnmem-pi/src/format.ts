/**
 * Model-facing text formatting for tool results and /memory output.
 *
 * Tool results are the only place where live/volatile data may appear; the
 * injected system-prompt snapshot must stay byte-stable, so nothing here is
 * ever injected automatically.
 */

import type {
  ForgetResult,
  ReadResult,
  SearchResult,
  Stats,
  WriteResult,
} from "@harnmem/core";

const MAX_TOOL_TEXT = 12_000;

function clip(text: string, max = MAX_TOOL_TEXT): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

function fmtTime(ms: number): string {
  if (!ms) return "-";
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatWrite(result: WriteResult): string {
  const lines: string[] = [];
  switch (result.action) {
    case "NEW":
      lines.push(`stored ${result.id} (NEW)`);
      break;
    case "SKIP":
      lines.push(`already exists ${result.id} (SKIP)`);
      break;
    case "MERGE":
      lines.push(`merged into ${result.id} (MERGE)`);
      break;
    case "SUPERSEDE":
      lines.push(`superseded ${result.superseded.join(", ") || "(none)"} → ${result.id}`);
      break;
    case "LINK":
      lines.push(`linked to existing ${result.id} (LINK)`);
      break;
  }
  if (result.warnings.length) lines.push(`warnings: ${result.warnings.join("; ")}`);
  lines.push("Use memory_read with this id for the full record; memory_search to find related memories.");
  return clip(lines.join("\n"));
}

export function formatSearch(result: SearchResult): string {
  if (result.abstained || result.results.length === 0) {
    return clip(
      `no confident memories for "${result.query}" (abstained). Try different keywords, or memory_status to inspect the store.`,
    );
  }
  const lines: string[] = [`${result.results.length}/${result.total} matches for "${result.query}":`];
  for (const hit of result.results) {
    const flags = [hit.status !== "active" ? hit.status : "", hit.pinned ? "pinned" : "", hit.historical ? "historical" : ""]
      .filter(Boolean)
      .join(",");
    lines.push(
      `- ${hit.id} [${hit.type}${hit.category ? "/" + hit.category : ""}${flags ? " (" + flags + ")" : ""}] ${hit.title} — ${hit.description}` +
        (hit.snippet ? `\n  ${hit.snippet.replace(/\s+/g, " ").slice(0, 240)}` : ""),
    );
  }
  if (result.debug) {
    lines.push(`debug: candidates=${result.debug.candidateCount} shards=${result.debug.shards.join(",")} elapsed=${result.debug.elapsedMs}ms`);
  }
  lines.push("Call memory_read <id> to open a record.");
  return clip(lines.join("\n"));
}

export function formatRead(result: ReadResult | null, id: string): string {
  if (!result) return `not found: ${id}`;
  const r = result.record;
  const lines: string[] = [
    `${r.id} [${r.type}${r.category ? "/" + r.category : ""}] ${r.scope}${r.project ? "/" + r.project : ""} status=${r.status} importance=${r.importance} confidence=${r.confidence}${r.pinned ? " pinned" : ""}`,
    `title: ${r.title}`,
    `description: ${r.description}`,
    `updated: ${fmtTime(r.updated)} created: ${fmtTime(r.created)} valid: ${fmtTime(r.validFrom)} → ${r.validTo ? fmtTime(r.validTo) : "now"}`,
  ];
  if (r.tags.length) lines.push(`tags: ${r.tags.join(", ")}`);
  if (r.entities.length) lines.push(`entities: ${r.entities.join(", ")}`);
  if (r.links.length) lines.push(`links: ${r.links.join(", ")}`);
  if (result.backlinks.length) lines.push(`backlinks: ${result.backlinks.join(", ")}`);
  if (result.history?.length) lines.push(`history: ${result.history.map((h) => h.id).join(", ")}`);
  lines.push("", r.content);
  return clip(lines.join("\n"));
}

export function formatForget(result: ForgetResult): string {
  return result.ok
    ? result.mode === "hard"
      ? `permanently deleted ${result.id}`
      : `moved ${result.id} to trash (restorable for the grace period; run \`/memory restore ${result.id}\` to restore)`
    : `could not forget ${result.id}`;
}

export function formatStats(stats: Stats): string {
  const lines: string[] = [
    `harnmem v${stats.version} home=${stats.home}`,
    `project: ${stats.project ?? "(none)"}`,
    `index: seq=${stats.index.seq} stale=${stats.index.stale} built=${fmtTime(stats.index.builtAt)} size=${stats.index.sizeBytes}B overhead=${(stats.index.overhead * 100).toFixed(0)}%`,
  ];
  for (const shard of stats.shards) {
    lines.push(
      `shard ${shard.name} [${shard.scope}] total=${shard.total} active=${shard.active} superseded=${shard.superseded} archived=${shard.archived} pinned=${shard.pinned} ${Math.round(shard.bytes / 1024)}KB`,
    );
  }
  if (stats.shards.length === 0) lines.push("no shards yet (empty store)");
  lines.push(
    `health: overBudget=${stats.health.overBudget} duplicates=${stats.health.duplicateCandidates} orphans=${stats.health.orphans} lastConsolidate=${stats.health.lastConsolidate ? fmtTime(stats.health.lastConsolidate) : "never"}`,
  );
  lines.push(
    `extraction: pending=${stats.extraction.pending} failed=${stats.extraction.failed}` +
      (Object.keys(stats.extraction.skipReasons).length ? ` skip=${JSON.stringify(stats.extraction.skipReasons)}` : ""),
  );
  return clip(lines.join("\n"));
}

export function formatConsolidation(report: {
  runId: string;
  merged: Array<{ into: string; from: string[] }>;
  archived: string[];
  digestsWritten: string[];
  skipped: number;
  llmCalls: number;
  dryRun: boolean;
  startedAt: number;
  finishedAt: number;
}): string {
  return clip(
    [
      `consolidate ${report.runId}${report.dryRun ? " (dry run)" : ""} in ${report.finishedAt - report.startedAt}ms`,
      `merged groups: ${report.merged.length}; archived: ${report.archived.length}; digests: ${report.digestsWritten.length}; skipped: ${report.skipped}; llmCalls: ${report.llmCalls}`,
    ].join("\n"),
  );
}
