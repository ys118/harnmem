#!/usr/bin/env node
/**
 * HarnMem MCP stdio server for Codex (JSON-RPC 2.0 over ndjson).
 *
 * One server carries all four adapter-contract layers (probe-verified,
 * docs/research/codex-plugin.md):
 *  - Tools: the five canonical memory tools
 *    (memory_search / memory_read / memory_write / memory_forget /
 *    memory_status) as mcp__harnmem__memory_* once installed as a plugin.
 *  - Injection: the SessionStart hook is a mcp_tool hook targeting
 *    `memory_context`; Codex materializes the tool's text return as a
 *    developer message (content kind `hooks.additional_context`), which is how
 *    the byte-stable snapshot enters the rollout.
 *  - Lifecycle: the SessionEnd hook targets `memory_session_end`, which writes
 *    a payload file and spawns the detached extract worker (Codex hook
 *    timeouts are 1-3 s, far below extraction budget; see
 *    lib/extract-worker.mjs).
 *
 * Protocol shape (same as the Claude adapter, verified 2026-10-26):
 *  - one JSON message per line on stdin; responses only, never stdout noise —
 *    logs go to stderr (rule: adapters never write stdout outside the protocol).
 *  - initialize -> notifications/initialized -> tools/list -> tools/call loop;
 *    unknown methods return error -32601; bad params return -32602.
 *  - results are text content blocks; hard failures surface as isError=true
 *    with a human-readable message instead of crashing the server.
 */

import path from "node:path";

import { openEngine } from "../lib/engine.mjs";
import { resolveSettings } from "../lib/settings.mjs";
import { defaultCodexHome, findRecentRollouts } from "../lib/rollout.mjs";
import { formatForget, formatRead, formatSearch, formatStats, formatWrite } from "../lib/format.mjs";
import {
  capBytes,
  isNewerRolloutName,
  readBackfillMarker,
  runExtractPhase,
  spawnDetachedExtract,
  sweepStalePayloads,
  writePayload,
} from "../lib/extract-worker.mjs";

const SERVER_INFO = { name: "harnmem", version: "0.1.0" };
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
    // Internal: target of the SessionStart mcp_tool hook. Registered in
    // tools/list because Codex resolves hook tools by name, but the model is
    // not expected to call it.
    name: "memory_context",
    description:
      "Internal (SessionStart hook target). Returns the byte-stable HarnMem memory snapshot injected at session start. Do not call manually; use memory_search instead.",
    inputSchema: {
      type: "object",
      properties: {
        hook_event_name: { type: "string", description: "Provided by the hook template" },
        session_id: { type: "string", description: "Codex thread id, provided by the hook template" },
        cwd: { type: "string", description: "Session working directory, provided by the hook template" },
      },
    },
  },
  {
    // Internal: target of the SessionEnd mcp_tool hook. Spawns the detached
    // extract worker and returns immediately (hook timeout 1-3 s).
    name: "memory_session_end",
    description:
      "Internal (SessionEnd hook target). Schedules deferred HarnMem extraction for the ending session. Do not call manually.",
    inputSchema: {
      type: "object",
      properties: {
        hook_event_name: { type: "string", description: "Provided by the hook template" },
        session_id: { type: "string", description: "Codex thread id, provided by the hook template" },
        cwd: { type: "string", description: "Session working directory, provided by the hook template" },
      },
    },
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

async function callTool(name, args, ctx) {
  // Session anchoring: only the hook templates carry the real Codex thread id.
  // SessionStart fires before any model tool call, so the first non-empty
  // session_id becomes this server's session id and every later engine open
  // (model tools without a session_id) reuses it instead of opening a second,
  // unanchored engine.
  const incoming = typeof args.session_id === "string" && args.session_id.trim() ? args.session_id.trim() : undefined;
  if (incoming && !ctx.sessionId) {
    ctx.sessionId = incoming;
    if (typeof args.cwd === "string" && args.cwd.trim()) {
      const nextCwd = args.cwd.trim();
      if (nextCwd !== ctx.cwd) {
        ctx.cwd = nextCwd;
        // The server process runs from the plugin directory, so the startup
        // settings resolved against the wrong project. Only the hook template
        // knows the session working directory — re-resolve on anchor so
        // project-level .harnmem.json takes effect.
        ctx.settings = resolveSettings(nextCwd, process.env);
      }
    }
  }
  const { settings, sessionId, cwd } = ctx;
  switch (name) {
    case "memory_context":
      return memoryContext(args, ctx);
    case "memory_session_end":
      return memorySessionEnd(args, ctx);
  }
  const eng = await getEngine(settings, { sessionId, cwd, readOnly: false });
  switch (name) {
    case "memory_search": {
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
    default:
      return textResult(`unknown tool: ${name}`, true);
  }
}

/**
 * Session-start backfill (N16: Codex has no SessionEnd hook, so finished
 * sessions are captured when the NEXT session starts). Queues detached
 * extraction payloads for recent, not-yet-extracted rollouts — never blocks
 * injection (readdir + a few spawns), never throws.
 *
 * Codex 0.165 also supports UserPromptSubmit mcp_tool hooks (probe-verified),
 * but their return text accumulates as one developer message per turn, which
 * would break byte-stable injection — reserved, not used here.
 */
function queueBackfill(settings, sessionId, cwd) {
  try {
    const codexHome = defaultCodexHome(process.env);
    const candidates = findRecentRollouts(codexHome, sessionId, new Date(), 5);
    if (candidates.length === 0) return;
    const marker = settings.home ? readBackfillMarker(settings.home) : "";
    for (const candidate of candidates) {
      // The marker is a global high-water mark on rollout file names; older
      // sessions were either extracted or predate the feature.
      if (!isNewerRolloutName(candidate.name, marker)) continue;
      const payloadPath = writePayload({
        sessionId: candidate.threadId,
        cwd,
        codexHome,
        harnmemHome: settings.home || undefined,
        reason: "backfill",
        rolloutName: candidate.name,
      });
      spawnDetachedExtract(payloadPath);
    }
  } catch (err) {
    if (settings.debug) {
      process.stderr.write(`[harnmem:mcp] backfill queue failed: ${String(err?.message || err)}\n`);
    }
  }
}

/**
 * SessionStart hook target: the returned text is what Codex injects as the
 * developer message (hooks.additional_context). Injection rules (contract §1):
 *  - byte-stable across calls (core sessionStart/ensureContext caching);
 *  - empty store or inject=false -> empty string, nothing to inject;
 *  - never throw: a broken store must not fail the hook (textResult isError
 *    would still inject error text, so failures return an empty result).
 */
async function memoryContext(args, ctx) {
  const { settings, sessionId, cwd } = ctx;
  // Backfill runs regardless of inject=false: it is extraction, not injection.
  queueBackfill(settings, sessionId, cwd);
  if (settings.inject === false) return textResult("");
  try {
    const eng = await getEngine(settings, { sessionId, cwd, readOnly: false });
    const block = await eng.sessionStart({
      sessionId,
      cwd,
      reason: "session_start",
    });
    return textResult(capBytes(block?.text || ""));
  } catch (err) {
    if (settings.debug) {
      process.stderr.write(`[harnmem:mcp] sessionStart failed: ${String(err?.message || err)}\n`);
    }
    return textResult("");
  }
}

/**
 * SessionEnd hook target. Codex kills hooks after 1-3 s and extraction needs
 * tens of seconds, so this only persists the payload and spawns the detached
 * worker (same pattern as the Claude adapter's SessionEnd). With
 * HARNMEM_EXTRACT_SYNC=1 the extraction runs inline — tests and debugging
 * only, never in a live hook.
 */
async function memorySessionEnd(args, ctx) {
  const { settings, sessionId, cwd } = ctx;
  if (!sessionId) return textResult("harnmem: no session id, skipped session-end capture");
  try {
    const payloadPath = writePayload({
      sessionId,
      cwd,
      codexHome: process.env.CODEX_HOME || undefined,
      reason: typeof args.hook_event_name === "string" ? args.hook_event_name : "SessionEnd",
    });
    if (process.env.HARNMEM_EXTRACT_SYNC === "1") {
      const outcome = await runExtractPhase(payloadPath);
      return textResult(`harnmem session end captured (sync): ${outcome}`);
    }
    spawnDetachedExtract(payloadPath);
    sweepStalePayloads();
    return textResult("harnmem session end captured (deferred extraction)");
  } catch (err) {
    if (settings.debug) {
      process.stderr.write(`[harnmem:mcp] sessionEnd failed: ${String(err?.message || err)}\n`);
    }
    return textResult("harnmem session end capture failed (non-fatal)");
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
      case "initialize":
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        };
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOL_DEFINITIONS };
      case "tools/call": {
        if (!params || typeof params.name !== "string") return fail(-32602, "params.name is required");
        if (ctx.settings.enabled === false) {
          // Hook targets must degrade silently (empty injection, no capture)
          // instead of surfacing an error text into the rollout.
          if (params.name === "memory_context") return textResult("");
          if (params.name === "memory_session_end") return textResult("harnmem is disabled, skipped session-end capture");
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
  const cwd = process.cwd(); // plugin dir until the SessionStart hook anchors the real one
  const settings = resolveSettings(cwd, process.env);
  const ctx = { settings, sessionId: undefined, cwd };
  if (settings.debug) process.stderr.write(`[harnmem:mcp] starting, home=${path.resolve(settings.home)}\n`);

  let buffer = "";
  process.stdin.setEncoding("utf8");
  // The client may kill this process at any moment (hook timeout, crash):
  // a broken stdout pipe raises EPIPE, which must not surface as a crash.
  process.stdout.on("error", (err) => {
    if (err && err.code === "EPIPE") return;
    throw err;
  });
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
    // A well-formed client sends ndjson lines; a runaway peer without any
    // newline must not grow the buffer without bound. 8 MB is orders above
    // any legitimate request (the largest tool schema ~4 KB).
    const MAX_BUFFER_CHARS = 8 * 1024 * 1024;
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_BUFFER_CHARS && !buffer.includes("\n")) {
        buffer = "";
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "request too large" } });
        return;
      }
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
