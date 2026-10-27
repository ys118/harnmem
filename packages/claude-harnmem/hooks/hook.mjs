#!/usr/bin/env node
/**
 * Claude Code hook entry for HarnMem (SessionStart + SessionEnd).
 *
 * Hard rules (docs/design/09-claude-adapter.md, docs/research/claude-code-plugin.md):
 *  - stdout carries AT MOST one JSON payload (the injection); anything else
 *    goes to stderr. Any failure => stderr + exit 0, the session proceeds.
 *  - SessionStart builds the byte-stable snapshot via core ensureContext();
 *    an empty store prints nothing at all (0-byte injection rule).
 *  - SessionEnd must return immediately: plugin hook timeout declarations are
 *    not honored (remember #561), so the real work is re-spawned detached
 *    (stdio "ignore" so the client's pipe sees EOF — remember #646) and the
 *    hook exits 0 at once.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openEngine } from "../lib/engine.mjs";
import { resolveSettings } from "../lib/settings.mjs";
import { parseClaudeTranscript } from "../lib/transcript.mjs";

const selfPath = fileURLToPath(import.meta.url);
const MAX_INJECT_BYTES = 10_000; // Claude additionalContext hard cap (09 §3)
const STDIN_TIMEOUT_MS = 5_000;
const PAYLOAD_DIR = path.join(os.tmpdir(), "harnmem-claude");
const PAYLOAD_TTL_MS = 60 * 60 * 1000;

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

function isSubagent(payload) {
  // 09 §10: agent_type present and non-null => subagent session => read-only.
  return typeof payload.agent_type === "string" && payload.agent_type.length > 0;
}

/** Deterministic truncation to Claude's additionalContext byte cap. */
function capBytes(text, maxBytes = MAX_INJECT_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "\n<!-- harnmem: snapshot truncated to fit the 10,000-character additionalContext cap -->";
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  const out = [];
  let used = 0;
  for (const line of text.split("\n")) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  return out.join("\n") + suffix;
}

async function handleSessionStart(payload) {
  const settings = resolveSettings(payload.cwd || process.cwd(), process.env);
  if (!settings.enabled || !settings.inject) return;
  const source = typeof payload.source === "string" ? payload.source : "startup";
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
  const cwd = payload.cwd || process.cwd();
  const reason = source === "resume" ? "resume" : "session_start";
  try {
    const started = Date.now();
    const eng = await openEngine(settings, { sessionId, cwd, readOnly: isSubagent(payload) });
    const block = await eng.sessionStart({ sessionId, cwd, reason });
    await eng.close();
    const text = capBytes(block.text || "");
    debugLog(settings, "session-start", {
      source,
      reason,
      subagent: isSubagent(payload),
      bytes: Buffer.byteLength(text, "utf8"),
      ids: block.ids.length,
      ms: Date.now() - started,
    });
    if (!text) return; // empty store: inject nothing (0-byte rule)
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }),
    );
  } catch (err) {
    debugLog(settings, "session-start.failed", { error: String(err?.message || err) });
  }
}

async function handleSessionEnd(payload) {
  const settings = resolveSettings(payload.cwd || process.cwd(), process.env);
  if (!settings.enabled) return;
  try {
    await mkdir(PAYLOAD_DIR, { recursive: true });
    const safeId = String(payload.session_id || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    const payloadPath = path.join(PAYLOAD_DIR, `session-end-${safeId}-${Date.now()}.json`);
    await writeFile(payloadPath, JSON.stringify(payload), "utf8");
    if (process.env.HARNMEM_EXTRACT_SYNC === "1") {
      // Deterministic test seam: run the extraction phase inline.
      await runExtractPhase(payloadPath);
      return;
    }
    // Detached respawn: all three stdio channels are "ignore" so the host's
    // pipe sees EOF immediately (#646); detached + unref so we can exit(#561).
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
  const settings = resolveSettings(payload.cwd || process.cwd(), process.env);
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown";
  const cwd = payload.cwd || process.cwd();
  if (isSubagent(payload)) {
    // Contract: only the main session extracts/writes; subagents stay read-only.
    debugLog(settings, "extract-phase.subagent-skip", { sessionId });
    await rm(payloadPath, { force: true });
    return;
  }
  try {
    let messages = [];
    if (typeof payload.transcript_path === "string" && existsSync(payload.transcript_path)) {
      messages = parseClaudeTranscript(await readFile(payload.transcript_path, "utf8"));
    }
    const eng = await openEngine(settings, { sessionId, cwd, readOnly: isSubagent(payload) });
    const result = await eng.sessionEnd({
      sessionId,
      cwd,
      reason: typeof payload.reason === "string" ? payload.reason : "session_end",
      messages,
    });
    await eng.close();
    debugLog(settings, "extract-phase", { sessionId, status: result.status, added: result.added.length, skipReason: result.skipReason });
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

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return; // malformed stdin: never block the session
  }
  if (!payload || typeof payload !== "object") return;
  switch (payload.hook_event_name) {
    case "SessionStart":
      await handleSessionStart(payload);
      return;
    case "SessionEnd":
      await handleSessionEnd(payload);
      return;
    case "PreCompact":
      // v1: not registered in hooks.json. Claude keeps the transcript file
      // across compaction and fires SessionStart(source=compact) afterwards,
      // which already rebuilds the snapshot; no cursor handoff is needed.
      return;
    default:
      return; // unknown event: silently no-op
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
