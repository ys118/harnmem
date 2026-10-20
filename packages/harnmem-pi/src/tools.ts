/**
 * The five HarnMem tools. Registering them makes memory read/write usable by the
 * model and by a human via slash commands. Tool results are *not* injected into
 * the system prompt: the KV-cache-stable snapshot stays untouched.
 */

import { defineTool, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryCategory, MemoryScope, MemoryType } from "@harnmem/core";
import { formatForget, formatRead, formatSearch, formatStats, formatWrite } from "./format.js";
import type { Adapter } from "./state.js";

const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
const CATEGORIES = ["decision", "convention", "lesson", "pitfall", "state", "profile", "external"] as const;
const SCOPES = ["auto", "user", "project"] as const;
/** memory_search scope: SearchOptions.scope has no "auto" mode (write-only concept). */
const SEARCH_SCOPES = ["user", "project", "all"] as const;

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function engineOf(ctx: ExtensionToolContext, adapter: Adapter) {
  const eng = await adapter.ensureEngine(ctx);
  return eng;
}

export function registerTools(pi: ExtensionAPI, adapter: Adapter): void {
  pi.registerTool(
    defineTool({
      name: "memory_write",
      label: "Memory Write",
      description:
        "Store a durable memory (user preference, feedback/lesson, project fact, reference). " +
        "Use for facts worth remembering across sessions; do not store transient chat. " +
        "Returns a one-line outcome (NEW/SKIP/MERGE/SUPERSEDE/LINK).",
      parameters: Type.Object({
        type: Type.Unsafe<MemoryType>({ type: "string", enum: [...MEMORY_TYPES] }),
        title: Type.String({ description: "Short title (<=80 chars), shown in the hot index." }),
        content: Type.String({ description: "Full memory body in markdown." }),
        description: Type.String({ description: "One-line description shown in search results and the hot index." }),
        category: Type.Optional(Type.Unsafe<MemoryCategory>({ type: "string", enum: [...CATEGORIES] })),
        scope: Type.Optional(Type.Unsafe<MemoryScope | "auto">({ type: "string", enum: [...SCOPES] })),
        project: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        entities: Type.Optional(Type.Array(Type.String())),
        importance: Type.Optional(Type.Number({ description: "0..10 (higher = more important), default 5" })),
        confidence: Type.Optional(Type.Number({ description: "0..1, default 0.7" })),
        pinned: Type.Optional(Type.Boolean({ description: "Always inject into the hot index." })),
        links: Type.Optional(Type.Array(Type.String({ description: "memory id" }))),
        supersedes: Type.Optional(Type.Array(Type.String({ description: "memory id this replaces" }))),
        evidence: Type.Optional(Type.Array(Type.String())),
        sensitive: Type.Optional(Type.Boolean({ description: "Do not inject into the prompt; retrieval only." })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const eng = await engineOf(ctx, adapter);
        if (!eng) {
          return { content: [{ type: "text" as const, text: "harnmem: memory store is unavailable in this session" }], details: {} };
        }
        try {
          const input = params as Parameters<typeof eng.write>[0];
          // Defensive normalization: schema says 0..10 / 0..1, but a model may still
          // send a fractional importance (old prompt) or out-of-range values.
          if (input.importance !== undefined) input.importance = Math.max(0, Math.min(10, input.importance));
          if (input.confidence !== undefined) input.confidence = Math.max(0, Math.min(1, input.confidence));
          const result = await eng.write(input);
          if (result.action === "NEW" || result.action === "MERGE" || result.action === "SUPERSEDE" || result.action === "LINK") {
            adapter.markDirty("memory_write");
            eng.noteModelWrite();
          }
          adapter.logger?.info("tool.write", { id: result.id, action: result.action, type: params.type });
          return { content: [{ type: "text" as const, text: formatWrite(result) }], details: { id: result.id, action: result.action } };
        } catch (err) {
          adapter.logger?.warn("tool.write.error", { error: errText(err) });
          return { content: [{ type: "text" as const, text: `memory_write failed: ${errText(err)}` }], details: {}, isError: true };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_search",
      label: "Memory Search",
      description:
        "Search long-term memory by lexical/semantic-free BM25 over titles, descriptions, tags, entities and bodies. " +
        "Use before asking the user to repeat something or before making project decisions.",
      parameters: Type.Object({
        query: Type.String({ description: "Keywords, names, or a short natural-language query." }),
        limit: Type.Optional(Type.Number({ description: "Max results, default 8." })),
        scope: Type.Optional(Type.Unsafe<MemoryScope | "all">({ type: "string", enum: [...SEARCH_SCOPES] })),
        project: Type.Optional(Type.String()),
        include_archived: Type.Optional(Type.Boolean()),
        include_history: Type.Optional(Type.Boolean()),
        as_of: Type.Optional(Type.String({ description: "ISO date or epoch-ms: only facts valid at that instant." })),
        entity: Type.Optional(Type.String()),
        debug: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const eng = await engineOf(ctx, adapter);
        if (!eng) {
          return { content: [{ type: "text" as const, text: "harnmem: memory store is unavailable in this session" }], details: {} };
        }
        try {
          // Defensive: older schemas exposed "auto" for search too; treat it as "all".
          const rawScope = params.scope as string | undefined;
          const scope = rawScope === "auto" ? "all" : (rawScope as MemoryScope | "all" | undefined);
          const result = await eng.search({
            query: params.query,
            limit: params.limit,
            scope,
            project: params.project,
            includeArchived: params.include_archived,
            includeHistory: params.include_history,
            asOf: params.as_of,
            entity: params.entity,
            debug: params.debug,
          });
          adapter.logger?.debug("tool.search", { query: params.query, hits: result.results.length, abstained: result.abstained });
          return { content: [{ type: "text" as const, text: formatSearch(result) }], details: { total: result.total, abstained: result.abstained } };
        } catch (err) {
          adapter.logger?.warn("tool.search.error", { error: errText(err) });
          return { content: [{ type: "text" as const, text: `memory_search failed: ${errText(err)}` }], details: {}, isError: true };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_read",
      label: "Memory Read",
      description: "Open one memory record by id (frontmatter summary + body + backlinks).",
      parameters: Type.Object({
        id: Type.String({ description: "Memory id, e.g. mem_..." }),
        as_of: Type.Optional(Type.String()),
        include_history: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const eng = await engineOf(ctx, adapter);
        if (!eng) {
          return { content: [{ type: "text" as const, text: "harnmem: memory store is unavailable in this session" }], details: {} };
        }
        try {
          const result = await eng.read(params.id, {
            asOf: params.as_of,
            includeHistory: params.include_history,
          });
          adapter.logger?.debug("tool.read", { id: params.id, found: result !== null });
          return {
            content: [{ type: "text" as const, text: formatRead(result, params.id) }],
            details: { found: result !== null },
          };
        } catch (err) {
          adapter.logger?.warn("tool.read.error", { error: errText(err) });
          return { content: [{ type: "text" as const, text: `memory_read failed: ${errText(err)}` }], details: {}, isError: true };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_forget",
      label: "Memory Forget",
      description:
        "Forget a memory. Default moves it to trash (restorable); hard=true deletes permanently. " +
        "Use when the user corrects a fact or asks to forget something.",
      parameters: Type.Object({
        id: Type.String(),
        hard: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const eng = await engineOf(ctx, adapter);
        if (!eng) {
          return { content: [{ type: "text" as const, text: "harnmem: memory store is unavailable in this session" }], details: {} };
        }
        try {
          const result = await eng.forget(params.id, { hard: params.hard === true });
          adapter.markDirty("memory_write");
          adapter.logger?.info("tool.forget", { id: params.id, mode: result.mode, ok: result.ok });
          return { content: [{ type: "text" as const, text: formatForget(result) }], details: { ok: result.ok, mode: result.mode } };
        } catch (err) {
          adapter.logger?.warn("tool.forget.error", { error: errText(err) });
          return { content: [{ type: "text" as const, text: `memory_forget failed: ${errText(err)}` }], details: {}, isError: true };
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "memory_status",
      label: "Memory Status",
      description: "Show memory store health: shards, counts, capacities and pending events. Useful before large writes.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const eng = await engineOf(ctx, adapter);
        if (!eng) {
          return { content: [{ type: "text" as const, text: "harnmem: memory store is unavailable in this session" }], details: {} };
        }
        try {
          const stats = await eng.stats();
          adapter.logger?.debug("tool.status", { shards: stats.shards.length });
          return { content: [{ type: "text" as const, text: formatStats(stats) }], details: { version: stats.version } };
        } catch (err) {
          adapter.logger?.warn("tool.status.error", { error: errText(err) });
          return { content: [{ type: "text" as const, text: `memory_status failed: ${errText(err)}` }], details: {}, isError: true };
        }
      },
    }),
  );
}

/** Normalizes type/category/scope strings for code paths that bypass schema validation. */
export function asMemoryType(value: unknown): MemoryType | undefined {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value) ? (value as MemoryType) : undefined;
}

export function asMemoryCategory(value: unknown): MemoryCategory | undefined {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value) ? (value as MemoryCategory) : undefined;
}


