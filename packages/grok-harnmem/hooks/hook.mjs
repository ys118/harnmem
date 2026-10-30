#!/usr/bin/env node
/**
 * Grok CLI hook entry for HarnMem (SessionEnd only).
 *
 * Grok 1.0.70 facts this file is built around (probe P5/P10/P11/P13 in
 * docs/research/grok-plugin.md):
 *  - `SessionStart` is observe-only: additionalContext and plain stdout are
 *    dropped, a top-level systemMessage only reaches the client, and the
 *    system prompt is rendered before the hook runs. So this adapter does NOT
 *    register SessionStart; the memory index is injected through the MCP
 *    server's `initialize.instructions` instead (mcp/mcp.mjs).
 *  - `SessionEnd` hooks run with stdin JSON and are dispatched on the shell
 *    route at exit. A plugin's SessionEnd hook runs for at most the 1.5 s
 *    plugin default whatever the declared timeout is (10-hooks.md:110/648),
 *    so the real work is re-spawned detached (stdio "ignore" + unref) and the
 *    hook exits immediately.
 *  - Input carries both naming conventions: `hookEventName: "session_end"`
 *    plus `hook_event_name: "SessionEnd"`; the same applies to payload fields
 *    (sessionId/session_id, transcriptPath/transcript_path). Accept both.
 *
 * Hard rules: stdout stays empty; any failure => exit 0 (fail-open).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openEngine } from "../lib/engine.mjs";
import { resolveSettings } from "../lib/settings.mjs";
import { parseGrokChatHistory, parseGrokUpdates } from "../lib/transcript.mjs";

const selfPath = fileURLToPath(import.meta.url);
const STDIN_TIMEOUT_MS = 5_000;
const PAYLOAD_DIR = path.join(os.tmpdir(), "harnmem-grok");
const PAYLOAD_TTL_MS = 60 * 60 * 1000;

const SESSION_FILE = "chat_history.jsonl";
const FALLBACK_SESSION_FILE = "updates.jsonl";

function debugLog(settings, msg, data) {
  if (!settings?.debug) return;
  try {
    process.stderr.write(`[harnmem:debug] ${msg}${data === undefined ? "" : " " + JSON.stringify(data)}\n`);
  } catch {
    // best effort
  }
}

function readStdin(timeoutMs = STDIN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let data = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}

/** First non-empty string among the given payload keys. */
function pickString(payload, keys) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function isSubagent(payload) {
  // Grok uses `subagentType` for events fired inside a subagent (10-hooks.md),
  // not Claude's `agent_type`; accept both so fixtures stay portable.
  const value = payload.subagentType ?? payload.subagent_type ?? payload.agent_type;
  return typeof value === "string" && value.length > 0;
}

function grokHome() {
  const override = process.env.GROK_HOME;
  if (typeof override === "string" && override.length > 0) return path.resolve(override);
  return path.join(os.homedir(), ".grok");
}

/**
 * Locate the session directory from the hook payload.
 * Preferred: transcriptPath (Grok points it at updates.jsonl; 25-status-line.md:91).
 * Fallback: scan <GROK_HOME>/sessions/<urlencoded-cwd>/<sessionId>/ — the group
 * directory name is the URL-encoded workspace cwd, and the session id is the
 * UUIDv7 directory inside it (17-sessions.md).
 */
async function resolveSessionDir(payload, cwd) {
  const sessionId = pickString(payload, ["sessionId", "session_id"]);
  const transcriptPath = pickString(payload, ["transcriptPath", "transcript_path"]);
  if (transcriptPath) return path.dirname(transcriptPath);

  const root = path.join(grokHome(), "sessions");
  if (!sessionId || !existsSync(root)) return undefined;
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, sessionId);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // advisory only
  }
  return undefined;
}

/** Read the session transcript: chat_history.jsonl first, updates.jsonl fallback. */
async function readSessionMessages(payload, cwd) {
  const dir = await resolveSessionDir(payload, cwd);
  if (!dir) return [];
  const historyPath = path.join(dir, SESSION_FILE);
  if (existsSync(historyPath)) return parseGrokChatHistory(await readFile(historyPath, "utf8"));
  const updatesPath = path.join(dir, FALLBACK_SESSION_FILE);
  if (existsSync(updatesPath)) return parseGrokUpdates(await readFile(updatesPath, "utf8"));
  return [];
}

async function handleSessionEnd(payload) {
  const cwd = pickString(payload, ["cwd", "workspaceRoot", "workspace_root"]) || process.cwd();
  const settings = resolveSettings(cwd, process.env);
  if (!settings.enabled) return;
  try {
    await mkdir(PAYLOAD_DIR, { recursive: true });
    const sessionId = pickString(payload, ["sessionId", "session_id"]) || "unknown";
    const safeId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
    const payloadPath = path.join(PAYLOAD_DIR, `session-end-${safeId}-${Date.now()}.json`);
    await writeFile(payloadPath, JSON.stringify(payload), "utf8");
    if (process.env.HARNMEM_EXTRACT_SYNC === "1") {
      // Deterministic test seam: run the extraction phase inline.
      await runExtractPhase(payloadPath);
      return;
    }
    // Detached respawn: all three stdio channels are "ignore" so the host's
    // pipe sees EOF immediately; detached + unref so we can exit inside the
    // plugin SessionEnd budget.
    const child = spawn(process.execPath, [selfPath, "--extract-phase", payloadPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HARNMEM_EXTRACT_PHASE: "1" },
    });
    // Without a listener an async spawn error (e.g. ENOENT) becomes an
    // uncaught exception; swallow it, the session must always proceed.
    child.on("error", () => {});
    child.unref();
    debugLog(settings, "session-end.respawned", { payloadPath, subagent: isSubagent(payload) });
  } catch (err) {
    debugLog(settings, "session-end.spawn-failed", { error: String(err?.message || err) });
  }
}

async function runExtractPhase(payloadPath) {
  let payload = {};
  try {
    payload = JSON.parse(await readFile(payloadPath, "utf8"));
  } catch {
    await rm(payloadPath, { force: true });
    return;
  }
  const cwd = pickString(payload, ["cwd", "workspaceRoot", "workspace_root"]) || process.cwd();
  const settings = resolveSettings(cwd, process.env);
  const sessionId = pickString(payload, ["sessionId", "session_id"]) || "unknown";
  if (isSubagent(payload)) {
    // Contract: only the main session extracts/writes; subagents stay read-only.
    debugLog(settings, "extract-phase.subagent-skip", { sessionId });
    await rm(payloadPath, { force: true });
    return;
  }
  try {
    const messages = await readSessionMessages(payload, cwd);
    const eng = await openEngine(settings, { sessionId, cwd, readOnly: false });
    const result = await eng.sessionEnd({
      sessionId,
      cwd,
      reason: pickString(payload, ["reason"]) || "session_end",
      messages,
    });
    await eng.close();
    debugLog(settings, "extract-phase", {
      sessionId,
      status: result.status,
      added: result.added.length,
      skipReason: result.skipReason,
    });
  } catch (err) {
    debugLog(settings, "extract-phase.failed", { error: String(err?.message || err) });
  } finally {
    await rm(payloadPath, { force: true });
    await sweepStalePayloads();
  }
}

/** Three-state-ish cleanup: payload files older than TTL are orphans. */
async function sweepStalePayloads() {
  try {
    const now = Date.now();
    for (const file of await readdir(PAYLOAD_DIR)) {
      if (!file.startsWith("session-end-") || !file.endsWith(".json")) continue;
      const full = path.join(PAYLOAD_DIR, file);
      const s = await stat(full);
      if (now - s.mtimeMs > PAYLOAD_TTL_MS) await rm(full, { force: true });
    }
  } catch {
    // cleanup is advisory
  }
}

/** Grok sends both `hook_event_name: "SessionEnd"` and `hookEventName: "session_end"`. */
function hookEventName(payload) {
  const explicit = pickString(payload, ["hook_event_name"]);
  if (explicit) return explicit;
  const snake = pickString(payload, ["hookEventName"]);
  return snake === "session_end" ? "SessionEnd" : snake;
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return; // malformed stdin: never block the session
  }
  if (!payload || typeof payload !== "object") return;
  switch (hookEventName(payload)) {
    case "SessionEnd":
      await handleSessionEnd(payload);
      return;
    default:
      return; // v1 registers SessionEnd only; unknown events are silent no-ops
  }
}

if (process.env.HARNMEM_EXTRACT_PHASE === "1") {
  const payloadPath = process.argv[3] || process.argv[2] || "";
  runExtractPhase(payloadPath)
    .catch(() => {})
    .finally(() => process.exit(0));
} else {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
