/**
 * Model-facing text formatting for MCP tool results and /memory output.
 * Port of packages/pi-harnmem/src/format.ts so every harness shows identical
 * tool-output shapes. Tool results are the only place where live data may
 * appear; the injected snapshot stays byte-stable (nothing here is injected).
 */

const MAX_TOOL_TEXT = 12_000;

function clip(text, max = MAX_TOOL_TEXT) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[truncated ${text.length - max} chars]`;
}

function fmtTime(ms) {
  if (!ms) return "-";
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatWrite(result) {
  const lines = [];
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
    default:
      lines.push(`write result: ${result.action} ${result.id}`);
  }
  if (result.warnings?.length) lines.push(`warnings: ${result.warnings.join("; ")}`);
  // Contract (docs/adapter-authoring.md §2): the write tool returns exactly one
  // line — "stored mem_x (NEW)" / "(SKIP)" / "superseded a → b" — no guidance.
  return clip(lines.join("\n"));
}

export function formatSearch(result) {
  if (result.abstained || result.results.length === 0) {
    return clip(
      `no confident memories for "${result.query}" (abstained). Try different keywords, or the memory status tool to inspect the store.`,
    );
  }
  const lines = [`${result.results.length}/${result.total} matches for "${result.query}":`];
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
    // Defensive (matches the codex adapter): shards is typed string[] but a
    // hostile/host-reshaped object must not throw inside a tool result.
    const shards = Array.isArray(result.debug.shards) ? result.debug.shards.join(",") : String(result.debug.shards ?? "?");
    lines.push(`debug: candidates=${result.debug.candidateCount} shards=${shards} elapsed=${result.debug.elapsedMs}ms`);
  }
  lines.push("Call the memory read tool with a hit id to open the record.");
  return clip(lines.join("\n"));
}

export function formatRead(result, id) {
  if (!result) return `not found: ${id}`;
  const r = result.record;
  const lines = [
    `${r.id} [${r.type}${r.category ? "/" + r.category : ""}] ${r.scope}${r.project ? "/" + r.project : ""} status=${r.status} importance=${r.importance} confidence=${r.confidence}${r.pinned ? " pinned" : ""}`,
    `title: ${r.title}`,
    `description: ${r.description}`,
    `updated: ${fmtTime(r.updated)} created: ${fmtTime(r.created)} valid: ${fmtTime(r.validFrom)} → ${r.validTo ? fmtTime(r.validTo) : "now"}`,
  ];
  if (r.tags?.length) lines.push(`tags: ${r.tags.join(", ")}`);
  if (r.entities?.length) lines.push(`entities: ${r.entities.join(", ")}`);
  if (r.links?.length) lines.push(`links: ${r.links.join(", ")}`);
  if (result.backlinks?.length) lines.push(`backlinks: ${result.backlinks.join(", ")}`);
  if (result.history?.length) lines.push(`history: ${result.history.map((h) => h.id).join(", ")}`);
  lines.push("", r.content);
  return clip(lines.join("\n"));
}

export function formatForget(result) {
  return result.ok
    ? result.mode === "hard"
      ? `permanently deleted ${result.id}`
      : `moved ${result.id} to trash (restorable for the grace period; restore with the harnmem CLI)`
    : `could not forget ${result.id}`;
}

export function formatStats(stats) {
  const lines = [
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
