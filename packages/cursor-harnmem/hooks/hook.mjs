#!/usr/bin/env node
/**
 * Cursor hook entry for HarnMem (beforeSubmitPrompt injection + sessionEnd
 * extraction).
 *
 * First-hand evidence on Cursor desktop 3.27.22 (2026-10-30, see
 * docs/research/cursor-plugin.md §10 and .tmp/cursor-probe/findings.md):
 *  - `beforeSubmitPrompt` fires for every prompt and its stdout JSON
 *    `{ "additional_context": "..." }` reaches the model as a system reminder.
 *    This is NOT in the published output schema (docs list only
 *    `continue`/`user_message`); it is verified by a token-recall experiment
 *    (v4) and is the channel this adapter depends on.
 *  - `sessionStart` DOES fire for new conversations, but its
 *    `additional_context` is dropped (the long-standing ordering bug is still
 *    present in 3.27.22). It is therefore not registered.
 *  - `sessionEnd` receives `transcript_path` and `reason`, and is
 *    fire-and-forget: the hook must return immediately, so the real work is
 *    re-spawned detached (stdio "ignore" so the host's pipe sees EOF).
 *
 * Hard rules shared with the Claude adapter:
 *  - stdout carries AT MOST one JSON payload; anything else goes to stderr.
 *    Any failure => stderr + exit 0, the conversation proceeds.
 *  - An empty store prints nothing at all (0-byte injection rule).
 *  - Injection happens once per conversation: a marker keyed by
 *    `conversation_id` (fallback `session_id`) keeps later prompts cheap
 *    (no engine boot) and keeps the injected snapshot byte-stable, which is
 *    what preserves prompt-cache hits inside a conversation.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { capBytes } from "../lib/cap.mjs";
import { openEngine } from "../lib/engine.mjs";
import { resolveSettings } from "../lib/settings.mjs";
import { parseCursorTranscript } from "../lib/transcript.mjs";

const selfPath = fileURLToPath(import.meta.url);
const STDIN_TIMEOUT_MS = 5_000;
// Tests point HARNMEM_CURSOR_STATE_DIR at a temp dir so marker/payload state
// never leaks between runs (or onto a real user's %TMP%).
const STATE_DIR = process.env.HARNMEM_CURSOR_STATE_DIR
  ? path.resolve(process.env.HARNMEM_CURSOR_STATE_DIR)
  : path.join(os.tmpdir(), "harnmem-cursor");
const MARKER_DIR = path.join(STATE_DIR, "injected");
const MARKER_TTL_MS = 48 * 60 * 60 * 1000;
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

/**
 * Write one JSON payload to stdout and resolve after the write is flushed.
 * `process.exit(0)` right after an unresolved pipe write would truncate the
 * injection, so the flush is awaited explicitly.
 */
function writePayload(value) {
  const json = JSON.stringify(value);
  return new Promise((resolve) => {
    try {
      process.stdout.write(json, () => resolve());
    } catch {
      resolve();
    }
  });
}

/** Normalize the Cursor payload path's project directory. */
function resolveProjectDir(payload = {}, env = process.env) {
  const fromEnv = env.CURSOR_PROJECT_DIR || env.CLAUDE_PROJECT_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim()) return path.resolve(fromEnv.trim());
  if (typeof payload.cwd === "string" && payload.cwd.trim()) return path.resolve(payload.cwd.trim());
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
  for (const root of roots) {
    if (typeof root === "string" && root.trim()) {
      // Cursor sends "/D:/projects/x" style roots on Windows.
      const normalized = root.replace(/^\/([A-Za-z]:)/, "$1").replace(/^\/([A-Za-z])\//, "$1:/");
      return path.resolve(normalized);
    }
  }
  return process.cwd();
}

function isBackgroundAgent(payload = {}) {
  // Background/cloud agents are read-only in the contract; their transcripts
  // are still journalled by the parent conversation, so skip them here.
  return payload.is_background_agent === true;
}

function conversationKey(payload = {}) {
  for (const candidate of [payload.conversation_id, payload.session_id]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  if (typeof payload.transcript_path === "string" && payload.transcript_path.trim()) {
    return path.basename(payload.transcript_path, path.extname(payload.transcript_path));
  }
  return "";
}

function markerPathFor(key) {
  const digest = createHash("sha1").update(key).digest("hex").slice(0, 24);
  return path.join(MARKER_DIR, `${digest}.json`);
}

/**
 * Create a claim file exclusively. Returns true for the winner only.
 *
 * Cursor may run the same step twice for one event: once from the user-level
 * `~/.cursor/hooks.json` entry and once from the plugin directory declared in
 * `.cursor-plugin/plugin.json` (both hit the same hook script). Without an
 * exclusive claim the first prompt would boot the engine twice and the
 * session-end extraction would journal every message twice.
 */
async function claimFile(file, contents) {
  try {
    await writeFile(file, contents, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw err;
  }
}

/** Read a conversation marker; any parse failure counts as "no marker". */
async function readMarker(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Claim file for one *prompt attempt* (conversation + generation). Duplicate
 * hook invocations share the generation id, so exactly one of them injects;
 * a retry after a failed turn gets a new generation and is allowed through.
 */
function attemptClaimPathFor(key, payload = {}) {
  const generation = typeof payload.generation_id === "string" ? payload.generation_id : "";
  const digest = createHash("sha1").update(`${key}|${generation}`).digest("hex").slice(0, 24);
  return path.join(MARKER_DIR, `claim-${digest}.json`);
}

/** Deterministic truncation moved to lib/cap.mjs so it is unit-testable. */

async function handleBeforeSubmitPrompt(payload) {
  const cwd = resolveProjectDir(payload);
  const settings = resolveSettings(cwd, process.env);
  if (!settings.enabled || !settings.inject) return;
  // Slash commands and ask-mode prompts do not need the memory index; only
  // the agent composer gets the injection (probe used composer_mode="agent").
  if (typeof payload.composer_mode === "string" && payload.composer_mode !== "agent") return;
  const key = conversationKey(payload);
  if (!key) return;
  const marker = markerPathFor(key);
  const state = await readMarker(marker);
  // `confirmed` means a model response was produced after the injection: the
  // context is part of this conversation's history and later prompts skip.
  // `pending` (or no marker) means the turn may have errored before the model
  // ran (e.g. "model unavailable"), so a retry must be able to re-inject.
  if (state && state.state === "confirmed") return;
  const sessionId = key;
  try {
    await mkdir(MARKER_DIR, { recursive: true });
    const claim = attemptClaimPathFor(key, payload);
    // Duplicate hook invocations for this prompt race here; only the winner
    // injects (Cursor may run the event from user config and plugin config).
    const claimed = await claimFile(claim, JSON.stringify({ key, at: Date.now() }));
    if (!claimed) return;
    const started = Date.now();
    const eng = await openEngine(settings, { sessionId, cwd });
    const block = await eng.sessionStart({ sessionId, cwd, reason: "session_start" });
    await eng.close();
    const text = capBytes(block.text || "");
    debugLog(settings, "before-submit-prompt.inject", {
      conversation: key,
      attempt: (state?.attempts || 0) + 1,
      bytes: Buffer.byteLength(text, "utf8"),
      ids: block.ids.length,
      ms: Date.now() - started,
    });
    // Empty store: inject nothing (0-byte rule) but remember the decision so
    // later prompts of the same conversation do not boot the engine again.
    await writeFile(
      marker,
      JSON.stringify({
        key,
        sessionId,
        state: "pending",
        attempts: (state?.attempts || 0) + 1,
        bytes: Buffer.byteLength(text, "utf8"),
        ids: block.ids.length,
        at: Date.now(),
      }),
      "utf8",
    );
    await sweepStaleMarkers();
    if (!text) return;
    await writePayload({ additional_context: text });
  } catch (err) {
    debugLog(settings, "before-submit-prompt.failed", { error: String(err?.message || err) });
    // Release the claim so the next prompt of this conversation can retry; a
    // half-finished pending marker would suppress nothing but a stuck claim
    // would block every retry of this generation.
    await rm(claim, { force: true }).catch(() => {});
  }
}

async function handleAfterAgentResponse(payload) {
  const cwd = resolveProjectDir(payload);
  const settings = resolveSettings(cwd, process.env);
  if (!settings.enabled) return;
  const key = conversationKey(payload);
  if (!key) return;
  const marker = markerPathFor(key);
  const state = await readMarker(marker);
  try {
    await mkdir(MARKER_DIR, { recursive: true });
    // A response proves the injected snapshot reached the model for this
    // conversation, so later prompts can skip the engine boot.
    await writeFile(
      marker,
      JSON.stringify({
        key,
        sessionId: state?.sessionId || key,
        state: "confirmed",
        attempts: state?.attempts || 0,
        bytes: state?.bytes || 0,
        ids: state?.ids || 0,
        at: state?.at || Date.now(),
        confirmedAt: Date.now(),
      }),
      "utf8",
    );
  } catch (err) {
    debugLog(settings, "after-agent-response.failed", { error: String(err?.message || err) });
  }
}

async function handleSessionEnd(payload) {
  const cwd = resolveProjectDir(payload);
  const settings = resolveSettings(cwd, process.env);
  if (!settings.enabled) return;
  if (isBackgroundAgent(payload)) {
    debugLog(settings, "session-end.background-skip", { sessionId: payload.session_id });
    return;
  }
  if (typeof payload.transcript_path !== "string" || !payload.transcript_path.trim()) {
    debugLog(settings, "session-end.no-transcript", { sessionId: payload.session_id });
    return;
  }
  try {
    await mkdir(STATE_DIR, { recursive: true });
    const safeId = String(payload.conversation_id || payload.session_id || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
    // One claim per (conversation, transcript, reason): duplicate hook
    // invocations for the same sessionEnd must journal the session once.
    const claimDigest = createHash("sha1")
      .update([conversationKey(payload), payload.transcript_path, String(payload.reason || "")].join("|"))
      .digest("hex")
      .slice(0, 24);
    const claim = path.join(STATE_DIR, `session-end-claim-${claimDigest}.json`);
    const claimed = await claimFile(claim, JSON.stringify({ sessionId: safeId, at: Date.now() }));
    if (!claimed) {
      debugLog(settings, "session-end.duplicate-skip", { sessionId: safeId });
      return;
    }
    const payloadPath = path.join(STATE_DIR, `session-end-${safeId}-${Date.now()}.json`);
    // Persist the resolved cwd too: the detached child cannot rely on the
    // inherited environment for project detection.
    await writeFile(payloadPath, JSON.stringify({ ...payload, cwd }), "utf8");
    if (process.env.HARNMEM_EXTRACT_SYNC === "1") {
      // Deterministic test seam: run the extraction phase inline.
      await runExtractPhase(payloadPath);
      return;
    }
    // Detached respawn: all three stdio channels are "ignore" so the host's
    // pipe sees EOF immediately; detached + unref so the hook can exit now.
    const child = spawn(process.execPath, [selfPath, "--extract-phase", payloadPath], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HARNMEM_EXTRACT_PHASE: "1" },
    });
    // Without a listener an async spawn error (e.g. ENOENT) becomes an
    // uncaught exception; swallow it, the session must always proceed.
    child.on("error", () => {});
    child.unref();
    debugLog(settings, "session-end.respawned", { payloadPath });
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
  const cwd = resolveProjectDir(payload);
  const settings = resolveSettings(cwd, process.env);
  const sessionId = conversationKey(payload) || "unknown";
  if (isBackgroundAgent(payload)) {
    debugLog(settings, "extract-phase.background-skip", { sessionId });
    await rm(payloadPath, { force: true });
    return;
  }
  try {
    let messages = [];
    if (typeof payload.transcript_path === "string" && existsSync(payload.transcript_path)) {
      messages = parseCursorTranscript(await readFile(payload.transcript_path, "utf8"));
    }
    if (messages.length === 0) {
      debugLog(settings, "extract-phase.empty-transcript", { sessionId });
      return;
    }
    const eng = await openEngine(settings, { sessionId, cwd });
    const result = await eng.sessionEnd({
      sessionId,
      cwd,
      reason: typeof payload.reason === "string" ? payload.reason : "session_end",
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

/** Payload files older than TTL are orphans (the child died before cleanup). */
async function sweepStalePayloads() {
  try {
    const now = Date.now();
    for (const file of await readdir(STATE_DIR)) {
      if (!file.startsWith("session-end-") || !file.endsWith(".json")) continue;
      const full = path.join(STATE_DIR, file);
      const s = await stat(full);
      if (now - s.mtimeMs > PAYLOAD_TTL_MS) await rm(full, { force: true });
    }
  } catch {
    // cleanup is advisory
  }
}

/** Conversation markers older than TTL are from long-gone conversations. */
async function sweepStaleMarkers() {
  try {
    const now = Date.now();
    for (const file of await readdir(MARKER_DIR)) {
      if (!file.endsWith(".json")) continue;
      const full = path.join(MARKER_DIR, file);
      const s = await stat(full);
      if (now - s.mtimeMs > MARKER_TTL_MS) await rm(full, { force: true });
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
    return; // malformed stdin: never block the conversation
  }
  if (!payload || typeof payload !== "object") return;
  const event =
    typeof payload.hook_event_name === "string" && payload.hook_event_name
      ? payload.hook_event_name
      : typeof process.argv[2] === "string"
        ? process.argv[2]
        : "";
  switch (event) {
    case "beforeSubmitPrompt":
      await handleBeforeSubmitPrompt(payload);
      return;
    case "afterAgentResponse":
      await handleAfterAgentResponse(payload);
      return;
    case "sessionEnd":
      await handleSessionEnd(payload);
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
