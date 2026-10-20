/**
 * The five `memory_*` tools (08 §5). Every tool is a thin wrapper over the core
 * engine —no retrieval logic lives in this package. Registration failures
 * degrade the adapter to "injection only" (the plugin must never break a turn).
 */

import type { ContextBlock, MemoryType, SearchOptions, SearchResult, WriteInput } from "@harnmem/core";
import type { SessionManager, AgentSession } from "./sessions.js";
import type { ToolDefinition, ToolExec, ToolParameter } from "./host.js";
import type { HostContext } from "./host.js";
import { Logger } from "./log.js";
import { errorMessage } from "./snapshot.js";

type Params = Record<string, ToolParameter>;

/** Local mirror of `defineTool`: identity when the host package is available. */
type DefineTool = <T extends ToolDefinition>(definition: T) => T;

function parameterDefinitions(parameters: Params): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, parameter] of Object.entries(parameters)) out[name] = parameter;
  return out;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return out.length > 0 ? out : undefined;
}

const MEMORY_TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

function formatTimestamp(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "?";
  return new Date(value).toISOString().slice(0, 10);
}

/** 03 §5.4 compact result payload, rendered as one JSON string. */
export function renderSearch(result: SearchResult): string {
  const payload = {
    query: result.query,
    total: result.total,
    results: result.results.map((hit) => ({
      id: hit.id,
      type: hit.type,
      scope: hit.scope,
      title: hit.title,
      description: hit.description,
      ...(hit.snippet ? { snippet: hit.snippet } : {}),
      ...(hit.pinned ? { pinned: true } : {}),
      ...(hit.status !== "active" ? { status: hit.status } : {}),
      ...(hit.historical ? { historical: true } : {}),
      updated: formatTimestamp(hit.updated),
    })),
    hint: "需要全文用 memory_read(id)",
  };
  if (result.abstained) return JSON.stringify({ query: result.query, total: 0, abstained: true, hint: "no memory is confident enough; fall back to normal reasoning" });
  return JSON.stringify(payload);
}

function renderWrite(id: string, action: string, superseded?: string[]): string {
  switch (action) {
    case "SKIP":
      return `already exists ${id} (SKIP)`;
    case "MERGE":
      return `merged into ${id} (MERGE)`;
    case "SUPERSEDE":
      return superseded && superseded.length > 0 ? `superseded ${superseded.join(", ")} —${id}` : `superseded by ${id}`;
    case "LINK":
      return `stored ${id} (LINK)`;
    case "NEW":
    default:
      return `stored ${id} (NEW)`;
  }
}

function renderRecord(record: Record<string, unknown>, backlinks: string[], historyCount: number, historical: boolean): string {
  const lines: string[] = [];
  const title = asString(record["title"]) ?? "?";
  const header = `[${String(record["type"])}${record["category"] ? `/${String(record["category"])}` : ""}] ${title} (${String(record["id"])})`;
  lines.push(header + (historical ? " (historical)" : ""));
  if (record["description"]) lines.push(`description: ${String(record["description"])}`);
  const meta: string[] = [];
  meta.push(`scope=${String(record["scope"])}`);
  if (record["project"]) meta.push(`project=${String(record["project"])}`);
  if (record["importance"] !== undefined) meta.push(`importance=${String(record["importance"])}`);
  if (record["pinned"]) meta.push("pinned");
  if (record["status"] && record["status"] !== "active") meta.push(`status=${String(record["status"])}`);
  meta.push(`created=${formatTimestamp(record["created"])}`);
  meta.push(`updated=${formatTimestamp(record["updated"])}`);
  const tags = Array.isArray(record["tags"]) ? record["tags"].map(String) : [];
  if (tags.length > 0) meta.push(`tags=${tags.join(",")}`);
  lines.push(meta.join(" "));
  if (record["supersededBy"]) lines.push(`superseded_by: ${String(record["supersededBy"])}`);
  if (record["validTo"] !== undefined && record["validTo"] !== null) {
    lines.push(`valid: ${formatTimestamp(record["validFrom"])} —${formatTimestamp(record["validTo"])}`);
  }
  const content = asString(record["content"]);
  if (content) {
    lines.push("", content);
  }
  if (backlinks.length > 0) lines.push("", `backlinks: ${backlinks.join(", ")}`);
  if (historyCount > 0) lines.push(`history: ${historyCount} older version(s); call memory_read(id, include_history=true)`);
  return lines.join("\n");
}

function renderStatus(stats: Awaited<ReturnType<import("@harnmem/core").HarnMem["stats"]>>): string {
  const shards = stats.shards.map(
    (shard) => `${shard.name}: ${shard.active} active / ${shard.total} total, ${shard.pinned} pinned`,
  );
  const lines = [
    `harnmem ${stats.version} · home ${stats.home} · project ${stats.project ?? "(none)"}`,
    ...shards,
    `index seq=${stats.index.seq} size=${stats.index.sizeBytes}B stale=${stats.index.stale}`,
    `health: overBudget=${stats.health.overBudget} duplicates=${stats.health.duplicateCandidates} orphans=${stats.health.orphans}` +
      (stats.health.lastConsolidate ? ` lastConsolidate=${formatTimestamp(stats.health.lastConsolidate)}` : ""),
    `extraction: pending=${stats.extraction.pending} failed=${stats.extraction.failed}` +
      (Object.keys(stats.extraction.skipReasons).length > 0 ? ` skips=${JSON.stringify(stats.extraction.skipReasons)}` : ""),
  ];
  return lines.join("\n");
}

export interface ToolDeps {
  ctx: HostContext;
  sessions: SessionManager;
  log: Logger;
}

/** Resolve the session for a tool call, booting it if the host skipped `agent/created`. */
async function stateFor(deps: ToolDeps, exec: ToolExec): Promise<AgentSession | null> {
  const agent = exec.agent;
  if (!agent) return null;
  let state = deps.sessions.forAgent(agent);
  if (!state) {
    try {
      state = await deps.sessions.attach(agent, "session_start");
    } catch (err) {
      deps.log.warn("tool.sessionUnavailable", { error: errorMessage(err) });
      return null;
    }
  }
  return state;
}

async function engineFor(deps: ToolDeps, exec: ToolExec) {
  const state = await stateFor(deps, exec);
  if (!state) return { state: null, engine: null };
  const engine = await deps.sessions.requireEngine(state);
  return { state, engine };
}

function unavailable(tool: string): string {
  return `${tool}: harnmem is unavailable in this session (engine could not be opened); no data was changed`;
}

export async function registerTools(deps: ToolDeps): Promise<boolean> {
  // The host's `defineTool` validates the definition. Published rc builds use a
  // stricter schema than the running 0.2.1 host (auto-memory's shipped code uses
  // the same loose `parameters`/`output` shape as below), so a rejection falls
  // back to the raw definition instead of losing the tool.
  let hostDefineTool: DefineTool | null = null;
  try {
    const mod: unknown = await import("@deepseek-ai/dsh-tools");
    const candidate = typeof mod === "object" && mod !== null ? (mod as { defineTool?: unknown }).defineTool : undefined;
    hostDefineTool = typeof candidate === "function" ? (candidate as DefineTool) : null;
  } catch {
    // Host package absent (unit tests / non-DSH): identity definition still
    // carries the same fields, registration degrades to "injection only" if
    // the host rejects it.
    hostDefineTool = null;
  }

  const define = (definition: ToolDefinition): ToolDefinition => {
    if (!hostDefineTool) return definition;
    try {
      return hostDefineTool(definition);
    } catch (err) {
      deps.log.debug("defineTool.fallback", { tool: definition.name, error: errorMessage(err) });
      return definition;
    }
  };

  /**
   * Every tool returns one plain string. The host's `defineTool` (0.2.x) requires
   * `output.render` to build the tool card, so declare a string schema plus a
   * text renderer. Tools registered by rc builds that reject this shape fall back
   * to the raw definition (see `define` above).
   */
  const stringOutput = {
    schema: { type: "string" },
    render: (_args: unknown, value: unknown): Array<{ type: "text"; text: string }> => [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
    ],
  };

  const definitions: ToolDefinition[] = [
    define({
      name: "memory_write",
      output: stringOutput,
      description:
        "Store one durable memory (preference, lesson, decision, project fact). Returns one line with the id and action.",
      parameters: {
        type: { type: "string", enum: MEMORY_TYPES, required: true, description: "user|feedback|project|reference" },
        category: { type: "string" },
        scope: { type: "string", enum: ["user", "project", "auto"] },
        title: { type: "string", required: true, description: "short stable title, <=80 chars" },
        description: { type: "string", required: true, description: "one line, <=200 chars" },
        content: { type: "string", required: true, description: "full markdown body" },
        tags: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } },
        importance: { type: "number", description: "0..10" },
        pinned: { type: "boolean" },
        links: { type: "array", items: { type: "string" } },
        supersedes: { type: "array", items: { type: "string" } },
      } satisfies Params,
      async execute(args, exec) {
        const { state, engine } = await engineFor(deps, exec);
        if (!engine) return unavailable("memory_write");
        const title = asString(args["title"]);
        const description = asString(args["description"]);
        const content = asString(args["content"]);
        const type = asString(args["type"]) as MemoryType | undefined;
        if (!type || !MEMORY_TYPES.includes(type) || !title || !description || !content) {
          return "memory_write: type/title/description/content are required; nothing was stored";
        }
        const scope = asString(args["scope"]);
        const input: WriteInput = {
          type,
          title,
          description,
          content,
          ...(asString(args["category"]) ? { category: asString(args["category"]) } : {}),
          ...(scope === "user" || scope === "project" ? { scope } : {}),
          ...(asStringArray(args["tags"]) ? { tags: asStringArray(args["tags"]) } : {}),
          ...(asStringArray(args["entities"]) ? { entities: asStringArray(args["entities"]) } : {}),
          ...(asNumber(args["importance"]) !== undefined ? { importance: asNumber(args["importance"]) } : {}),
          ...(asBoolean(args["pinned"]) !== undefined ? { pinned: asBoolean(args["pinned"]) } : {}),
          ...(asStringArray(args["links"]) ? { links: asStringArray(args["links"]) } : {}),
          ...(asStringArray(args["supersedes"]) ? { supersedes: asStringArray(args["supersedes"]) } : {}),
          source: { harness: "dsh", session: state?.sessionId, ts: Date.now() },
        };
        try {
          const result = await engine.write(input);
          if (state) await deps.sessions.afterModelWrite(state);
          return renderWrite(result.id, result.action, result.superseded);
        } catch (err) {
          return `memory_write failed: ${errorMessage(err)}`;
        }
      },
    }),
    define({
      name: "memory_search",
      output: stringOutput,
      description: "Search persistent memory (user + current project). Returns id/type/scope/title/description.",
      parameters: {
        query: { type: "string", required: true, description: "natural-language query; Chinese is matched by bigram" },
        limit: { type: "number" },
        scope: { type: "string", enum: ["user", "project", "all"] },
        include_archived: { type: "boolean" },
        as_of: { type: "string" },
        entity: { type: "string" },
        debug: { type: "boolean" },
      } satisfies Params,
      async execute(args, exec) {
        const { engine } = await engineFor(deps, exec);
        if (!engine) return unavailable("memory_search");
        const query = asString(args["query"]);
        if (!query) return "memory_search: query is required";
        const scopeValue = asString(args["scope"]);
        const options: SearchOptions = {
          query,
          limit: asNumber(args["limit"]) ?? 8,
          ...(scopeValue === "user" || scopeValue === "project" || scopeValue === "all" ? { scope: scopeValue } : { scope: "all" }),
          ...(asBoolean(args["include_archived"]) ? { includeArchived: true } : {}),
          ...(asString(args["as_of"]) ? { asOf: asString(args["as_of"]) } : {}),
          ...(asString(args["entity"]) ? { entity: asString(args["entity"]) } : {}),
          ...(asBoolean(args["debug"]) ? { debug: true } : {}),
        };
        try {
          return renderSearch(await engine.search(options));
        } catch (err) {
          return `memory_search failed: ${errorMessage(err)}`;
        }
      },
    }),
    define({
      name: "memory_read",
      output: stringOutput,
      description: "Read one memory in full by id, including backlinks and optionally older versions.",
      parameters: {
        id: { type: "string", required: true },
        as_of: { type: "string" },
        include_history: { type: "boolean" },
      } satisfies Params,
      async execute(args, exec) {
        const { engine } = await engineFor(deps, exec);
        if (!engine) return unavailable("memory_read");
        const id = asString(args["id"]);
        if (!id) return "memory_read: id is required";
        const asOf = asString(args["as_of"]);
        const includeHistory = asBoolean(args["include_history"]) ?? false;
        try {
          const result = await engine.read(id, {
            ...(asOf ? { asOf } : {}),
            ...(includeHistory ? { includeHistory: true } : {}),
            ...(asOf ? { asOf } : {}),
          });
          if (!result) return `no memory ${id}`;
          return renderRecord(
            result.record as unknown as Record<string, unknown>,
            result.backlinks,
            result.history?.length ?? 0,
            Boolean(asOf),
          );
        } catch (err) {
          return `memory_read failed: ${errorMessage(err)}`;
        }
      },
    }),
    define({
      name: "memory_forget",
      output: stringOutput,
      description:
        "Forget a memory. Default moves it to trash for 30 days; hard=true deletes physically and cannot be undone.",
      parameters: {
        id: { type: "string", required: true },
        hard: { type: "boolean" },
      } satisfies Params,
      async execute(args, exec) {
        const { state, engine } = await engineFor(deps, exec);
        if (!engine) return unavailable("memory_forget");
        const id = asString(args["id"]);
        if (!id) return "memory_forget: id is required";
        const hard = asBoolean(args["hard"]) ?? false;
        try {
          const result = await engine.forget(id, hard ? { hard: true } : undefined);
          if (!result.ok) return `no memory ${id}`;
          if (state) await deps.sessions.afterModelWrite(state);
          return hard
            ? `deleted ${id} (hard delete; audit keeps only id/time/reason)`
            : `moved ${id} to trash (30-day grace; memory_restore is not exposed as a tool)`;
        } catch (err) {
          return `memory_forget failed: ${errorMessage(err)}`;
        }
      },
    }),
    define({
      name: "memory_status",
      output: stringOutput,
      description: "Show memory store health: counts, index freshness, duplicates, last consolidation.",
      parameters: {} satisfies Params,
      async execute(_args, exec) {
        const { engine } = await engineFor(deps, exec);
        if (!engine) return unavailable("memory_status");
        try {
          return renderStatus(await engine.stats());
        } catch (err) {
          return `memory_status failed: ${errorMessage(err)}`;
        }
      },
    }),
  ];

  const tools = deps.ctx.tools;
  if (!tools) {
    deps.log.warn("tools.unavailable", { reason: "ctx.tools is missing; injection-only mode" });
    return false;
  }
  let registered = 0;
  for (const definition of definitions) {
    try {
      tools.register(definition);
      registered += 1;
    } catch (err) {
      deps.log.warn("tool.registerFailed", { tool: definition.name, error: errorMessage(err) });
    }
  }
  deps.log.debug("tools.registered", { count: registered, of: definitions.length });
  return registered === definitions.length;
}

/** Exposed for tests: the tool list is deterministic. */
export const TOOL_NAMES = ["memory_write", "memory_search", "memory_read", "memory_forget", "memory_status"] as const;

export type { ContextBlock };
