#!/usr/bin/env node
/**
 * HarnMem MCP stdio server for Grok CLI (JSON-RPC 2.0 over ndjson).
 *
 * Exposes six tools: the five canonical memory tools (contract §2)
 *   memory_search / memory_read / memory_write / memory_forget / memory_status
 * plus `memory_context` (the full hot-context snapshot; Grok's injected index
 * is truncated to fit the aggregate MCP reminder cap, probe P19).
 *
 * Why `instructions` matters here (docs/research/grok-plugin.md §1/§3):
 * Grok 1.0.70 renders the system prompt before SessionStart hooks and drops
 * SessionStart additionalContext/plain stdout (P10/P13), so the classic
 * Claude-style hook injection is impossible. The one model-visible pre-turn
 * channel that survives is the MCP server's `initialize.instructions`, which
 * Grok injects as a `<system-reminder>` ("MCP servers connected: …", P19) and
 * re-sends on later model calls. We therefore build the byte-stable snapshot
 * during `initialize` and return it as `instructions`, capped at
 * `maxInstructBytes` (default 2,500 bytes, well under the observed ~4.3 KB
 * aggregate truncation point).
 *
 * Protocol shape: one JSON message per line on stdin; responses only, never
 * stdout noise — logs go to stderr. Unknown methods return -32601; bad params
 * -32602; tool failures surface as isError=true text, never crash the server.
 */

import path from "node:path";
import { readFileSync } from "node:fs";

import { openEngine } from "../lib/engine.mjs";
import { resolveSettings } from "../lib/settings.mjs";
import { formatForget, formatRead, formatSearch, formatStats, formatWrite } from "../lib/format.mjs";

// Version tracks package.json so the MCP handshake never drifts (codex does the same).
const SERVER_INFO = {
  name: "harnmem",
  version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
};
const PROTOCOL_VERSION = "2024-11-05";

// Hard ceiling for any tool output (formatters already clip, but error paths
// bypass them). 12k chars ≈ 3-12k tokens, safely under the client's 25k-token
// MAX_MCP_OUTPUT_TOKENS cap even for CJK-heavy text.
const MAX_TOOL_RESULT_CHARS = 12_000;

function textResult(text, isError = false) {
  const safe =
    text.length <= MAX_TOOL_RESULT_CHARS
      ? text
      : text.slice(0, MAX_TOOL_RESULT_CHARS) + `\n…[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`;
  return { content: [{ type: "text", text: safe }], ...(isError ? { isError: true } : {}) };
}

/**
 * Deterministic byte-cap for the MCP `initialize.instructions` field.
 *
 * Grok prints instructions after "server (N tools): " and truncates the whole
 * aggregate reminder (~4.3 KB with one verbose server, probe P19), so our
 * share must stay small and end with a pointer to memory_context. Truncation
 * happens on a character boundary (never splits a UTF-8 code point) and backs
 * off to the last complete line when one is close enough.
 */
function capInstructText(text, maxBytes) {
  if (!text) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "\n… (memory index truncated; call memory_context for the full snapshot)";
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  let cut = "";
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > budget) break;
    cut += ch;
    used += size;
  }
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > cut.length * 0.5) cut = cut.slice(0, lastNewline);
  return cut.trimEnd() + suffix;
}

const TOOL_DEFINITIONS = [
  {
    name: "memory_search",
    description:
      "Search persistent cross-harness memory (user preferences, feedback, project decisions, references). Natural-language query; Chinese is matched by bigram. Prefer this before re-asking the user for known preferences or decisions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language search query (required)" },
        limit: { type: "integer", description: "Max hits to return (default 8)" },
        scope: { type: "string", enum: ["user", "project", "all"], description: "Scope filter (default all)" },
        include_archived: { type: "boolean", description: "Include archived/superseded records" },
        as_of: { type: "string", description: "Bi-temporal view: ISO date, or 'YYYY-MM-DD HH:MM' for minutes" },
        entity: { type: "string", description: "Filter by entity name" },
        debug: { type: "boolean", description: "Include retrieval diagnostics" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_read",
    description: "Read one memory in full by id, including backlinks and optionally older versions.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id, e.g. mem_x1y2z3" },
        as_of: { type: "string", description: "Historical view: ISO date-time" },
        include_history: { type: "boolean", description: "Include superseded versions" },
      },
      required: ["id"],
    },
  },
  {
    name: "memory_write",
    description:
      "Store one durable memory (preference, lesson, decision, project fact). Only when genuinely valuable; do not store transient task state. Returns one line with the id and action (NEW/SKIP/MERGE/SUPERSEDE/LINK).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["user", "feedback", "project", "reference"], description: "Memory type (required; unsure => project)" },
        title: { type: "string", description: "Short stable title, <=80 chars" },
        description: { type: "string", description: "One line, <=200 chars" },
        content: { type: "string", description: "Full markdown body (feedback/project should include **Why:**/**How to apply:** sections)" },
        category: { type: "string", description: "Optional free-form category" },
        scope: { type: "string", enum: ["auto", "user", "project"], description: "Storage scope (default auto)" },
        tags: { type: "array", items: { type: "string" } },
        entities: { type: "array", items: { type: "string" } },
        importance: { type: "integer", description: "0-10" },
        confidence: { type: "number", description: "0-1" },
        pinned: { type: "boolean" },
        links: { type: "array", items: { type: "string" }, description: "Related memory ids" },
        supersedes: { type: "array", items: { type: "string" }, description: "Memory ids this record replaces" },
      },
      required: ["type", "title", "description", "content"],
    },
  },
  {
    name: "memory_forget",
    description: "Forget one memory. Default moves it to trash for a grace period; hard=true deletes physically and cannot be undone.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory id" },
        hard: { type: "boolean", description: "Hard delete (skip trash)" },
      },
      required: ["id"],
    },
  },
  {
    // No parameters: core stats() is store-wide (same as pi memory_status).
    name: "memory_status",
    description: "Show HarnMem store health: shards, index freshness, duplicates, extraction backlog.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    // Grok-specific: the injected index is truncated (P19), so the model needs
    // an explicit way to pull the complete hot-context snapshot on demand.
    name: "memory_context",
    description:
      "Return HarnMem's full hot-context snapshot (the memory index injected at session start, before truncation). Use it when the injected index was cut off or you need the complete list of hottest memories.",
    inputSchema: { type: "object", properties: {} },
  },
];

let enginePromise = null;
let engineKey = "";

function getEngine(settings, opts) {
  const key = JSON.stringify([settings.home, opts.sessionId || "", opts.cwd || "", opts.readOnly === true]);
  if (!enginePromise || key !== engineKey) {
    engineKey = key;
    const opening = openEngine(settings, opts);
    enginePromise = opening.catch((err) => {
      // Do not cache failed opens: a transient error (file lock, index write
      // race) must not poison the singleton for the rest of the session.
      if (enginePromise === opening) {
        enginePromise = null;
        engineKey = "";
      }
      throw err;
    });
  }
  return enginePromise;
}

/**
 * Build the injected memory index during the MCP handshake.
 *
 * This is the load-bearing Grok-specific piece: the handshake happens before
 * the first model call, so instructions returned here reach the model even
 * though SessionStart hooks cannot (probe P19). Any failure must not break the
 * handshake — an empty string simply omits the field and the tools still work.
 */
async function buildInstructions(ctx) {
  const { settings, sessionId, cwd } = ctx;
  if (settings.enabled === false || settings.inject === false) return "";
  try {
    const eng = await getEngine(settings, { sessionId, cwd, readOnly: false });
    const block = await eng.sessionStart({ sessionId, cwd, reason: "session_start" });
    const text = capInstructText(block.text || "", settings.maxInstructBytes);
    if (settings.debug) {
      process.stderr.write(
        `[harnmem:mcp] instructions bytes=${Buffer.byteLength(text, "utf8")} ids=${block.ids.length} tokens=${block.tokensEstimate}\n`,
      );
    }
    return text;
  } catch (err) {
    if (settings.debug) process.stderr.write(`[harnmem:mcp] instructions failed: ${String(err?.message || err)}\n`);
    return "";
  }
}

async function callTool(name, args, ctx) {
  const { settings, sessionId, cwd } = ctx;
  const eng = await getEngine(settings, { sessionId, cwd, readOnly: false });
  switch (name) {    case "memory_search": {
      const result = await eng.search({
        query: String(args.query || ""),
        limit: Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : 8,
        scope: args.scope === "user" || args.scope === "project" ? args.scope : "all",
        includeArchived: args.include_archived === true,
        asOf: typeof args.as_of === "string" ? args.as_of : undefined,
        entity: typeof args.entity === "string" ? args.entity : undefined,
        debug: args.debug === true,
      });
      return textResult(formatSearch(result));
    }
    case "memory_read": {
      const result = await eng.read(String(args.id || ""), {
        asOf: typeof args.as_of === "string" ? args.as_of : undefined,
        includeHistory: args.include_history === true,
      });
      return textResult(formatRead(result, String(args.id || "")));
    }
    case "memory_write": {
      // Schema is a hint, not a guard (contract §3.6): old prompts may send
      // out-of-range numbers, so clamp like pi tools.ts does. The engine
      // clamps again, but never trust the transport.
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v)));
      const result = await eng.write({
        type: args.type,
        title: args.title,
        description: args.description,
        content: args.content,
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.scope !== undefined ? { scope: args.scope } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags } : {}),
        ...(Array.isArray(args.entities) ? { entities: args.entities } : {}),
        ...(args.importance !== undefined ? { importance: clamp(args.importance, 0, 10) } : {}),
        ...(args.confidence !== undefined ? { confidence: clamp(args.confidence, 0, 1) } : {}),
        ...(args.pinned !== undefined ? { pinned: args.pinned } : {}),
        ...(Array.isArray(args.links) ? { links: args.links } : {}),
        ...(Array.isArray(args.supersedes) ? { supersedes: args.supersedes } : {}),
      });
      eng.noteModelWrite();
      return textResult(formatWrite(result));
    }
    case "memory_forget": {
      const result = await eng.forget(String(args.id || ""), { hard: args.hard === true });
      return textResult(formatForget(result));
    }
    case "memory_status": {
      const stats = await eng.stats();
      return textResult(formatStats(stats));
    }
    case "memory_context": {
      // "manual" audits as a real injection (byte-stable snapshot, same as the
      // one shipped in initialize.instructions but untruncated).
      const block = await eng.ensureContext("manual");
      return textResult(block.text || "HarnMem store is empty (no memories yet).");
    }
    default:
      return textResult(`unknown tool: ${name}`, true);
  }
}

/**
 * Returns a response BODY (result object, or {__error, code, message}) or
 * undefined for notifications. onLine() wraps bodies into the JSON-RPC
 * envelope — the envelope must not be lost (tools/call responses are paired
 * with requests by id).
 */
async function handleRequest(msg, ctx) {
  const { method, params } = msg;
  const fail = (code, message) => ({ __error: true, code, message });

  try {
    switch (method) {
      case "initialize": {
        const instructions = await buildInstructions(ctx);
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          ...(instructions ? { instructions } : {}),
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOL_DEFINITIONS };
      case "tools/call": {
        if (!params || typeof params.name !== "string") return fail(-32602, "params.name is required");
        if (ctx.settings.enabled === false) {
          return textResult("HarnMem is disabled on this machine (HARNMEM_DISABLED or config). Enable it in ~/.harnmem/config.json.", true);
        }
        return await callTool(params.name, params.arguments || {}, ctx);
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  } catch (err) {
    const message = err?.code === "SCHEMA_NEWER" ? "memory store schema is newer than this adapter; run `harnmem` CLI to upgrade" : String(err?.message || err);
    return textResult(`harnmem error: ${message}`, true);
  }
}

async function main() {
  const cwd = process.cwd();
  // Grok starts plugin MCP servers without session env vars (probe P22), so this
  // is normally a synthetic id; provenance then relies on cwd + timestamps.
  const sessionId = process.env.HARNMEM_SESSION_ID || process.env.GROK_SESSION_ID || undefined;
  const settings = resolveSettings(cwd, process.env);
  const ctx = { settings, sessionId, cwd };
  if (settings.debug) process.stderr.write(`[harnmem:mcp] starting, home=${path.resolve(settings.home)}\n`);

  let buffer = "";
  process.stdin.setEncoding("utf8");
  const write = (obj) => {
    if (obj) process.stdout.write(JSON.stringify(obj) + "\n");
  };
  const respond = (id, body) => {
    if (id === undefined) return; // notification: never reply
    if (body === undefined) return;
    if (body && body.__error) write({ jsonrpc: "2.0", id, error: { code: body.code, message: body.message } });
    else write({ jsonrpc: "2.0", id, result: body });
  };
  const onLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (!msg || typeof msg !== "object") return;
    respond(msg.id, await handleRequest(msg, ctx));
  };

  await new Promise((resolve) => {
    let pending = Promise.resolve();
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        pending = pending.then(() => onLine(line)).catch(() => {});
      }
    });
    const finish = () => {
      resolve();
    };
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

main()
  .catch((err) => {
    process.stderr.write(`[harnmem:mcp] fatal: ${String(err?.message || err)}\n`);
    process.exit(0); // a broken MCP server must not take the session down
  });
