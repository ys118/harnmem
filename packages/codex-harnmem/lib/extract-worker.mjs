/**
 * Session-end payload + detached extract worker for the Codex adapter.
 *
 * Codex hook timeouts are 1-3 s and extraction needs tens of seconds, so the
 * SessionEnd hook tool (mcp.mjs) only persists a payload file here and spawns
 * this module as a detached `node lib/extract-worker.mjs <payloadPath>`
 * child (same pattern as the Claude adapter's SessionEnd, which cannot even
 * await its own child). The worker:
 *   1. reads the payload {sessionId, cwd, codexHome, reason, ts},
 *   2. resolves the rollout file under $CODEX_HOME/sessions (lib/rollout.mjs),
 *   3. parses it into TranscriptMessage[] and calls eng.sessionEnd —
 *      the single extraction entry point, which journals + audits every
 *      attempt (contract §4),
 *   4. consumes the payload file and sweeps stale siblings.
 *
 * Every failure is logged to stderr and exits 0: a broken extraction must
 * never produce a Windows error dialog or a failed-hook marker.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openEngine } from "./engine.mjs";
import { resolveSettings } from "./settings.mjs";
import { defaultCodexHome, findRolloutFile, parseCodexTranscript } from "./rollout.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(here, "extract-worker.mjs");

export const PAYLOAD_DIR = path.join(tmpdir(), "harnmem-codex");
export const PAYLOAD_TTL_MS = 60 * 60 * 1000; // 1 h, same as the Claude adapter

/** Hard byte cap for the session-start injection (same budget as Claude's). */
export const MAX_INJECT_BYTES = 10_000;

/**
 * Deterministic truncation to the injection byte cap: whole lines only, plus
 * a visible suffix so a truncated snapshot is never mistaken for a complete
 * one. Byte-stable input -> byte-stable output.
 */
export function capBytes(text, maxBytes = MAX_INJECT_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "\n<!-- harnmem: snapshot truncated to fit the 10,000-byte injection cap -->";
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

function safeId(sessionId) {
  return String(sessionId || "unknown").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "unknown";
}

/** Persist one session-end payload; returns the file path. */
export function writePayload(payload, dir = PAYLOAD_DIR) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `session-end-${safeId(payload.sessionId)}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(payload), "utf8");
  return file;
}

/** Delete payload files older than the TTL (crashed workers, skipped ends). */
export function sweepStalePayloads(dir = PAYLOAD_DIR, now = Date.now()) {
  if (!existsSync(dir)) return;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("session-end-") || !name.endsWith(".json")) continue;
    const full = path.join(dir, name);
    try {
      if (now - statSync(full).mtimeMs > PAYLOAD_TTL_MS) rmSync(full, { force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Detached spawn of this module for one payload. Fire-and-forget: the parent
 * returns immediately (hook timeout), errors on the child are logged by the
 * child itself.
 */
export function spawnDetachedExtract(payloadPath, env = process.env) {
  const child = spawn(process.execPath, [SELF, payloadPath], {
    detached: true,
    stdio: "ignore",
    env: { ...env, HARNMEM_EXTRACT_PHASE: "1" },
  });
  child.on("error", () => {
    // Spawn failures (rare) leave the payload for the TTL sweep.
  });
  child.unref();
  return child;
}

function log(message) {
  try {
    process.stderr.write(`[harnmem:extract] ${message}\n`);
  } catch {
    // stderr may be closed in detached mode
  }
}

/**
 * Consume one payload file. Returns a human-readable one-line outcome (also
 * the tool result under HARNMEM_EXTRACT_SYNC=1). Never throws.
 */
export async function runExtractPhase(payloadPath) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  } catch (err) {
    log(`unreadable payload ${payloadPath}: ${String(err?.message || err)}`);
    return "unreadable payload";
  }
  const { sessionId, cwd } = payload;
  try {
    // Subagent-style sessions have no id — nothing to anchor, nothing to journal.
    if (!sessionId) {
      rmSync(payloadPath, { force: true });
      return "skipped: no session id";
    }
    const codexHome = payload.codexHome || defaultCodexHome(process.env);
    const rollout = findRolloutFile(codexHome, sessionId);
    const raw = rollout ? readFileSync(rollout, "utf8") : "";
    const messages = parseCodexTranscript(raw);
    const settings = resolveSettings(typeof cwd === "string" && cwd ? cwd : process.cwd(), process.env);
    if (settings.enabled === false) {
      rmSync(payloadPath, { force: true });
      return "skipped: harnmem disabled";
    }
    const eng = await openEngine(settings, { sessionId, cwd, readOnly: false });
    let outcome;
    try {
      const result = await eng.sessionEnd({
        sessionId,
        cwd,
        reason: "session_end",
        messages,
      });
      outcome = result?.status ? `${result.status}${Array.isArray(result.added) && result.added.length ? ` added:${result.added.length}` : ""}` : "done";
    } finally {
      await eng.close().catch(() => {});
    }
    if (!rollout) outcome += " (rollout not found)";
    rmSync(payloadPath, { force: true });
    sweepStalePayloads();
    log(`${sessionId}: ${outcome}`);
    return outcome;
  } catch (err) {
    // Keep the payload on failure: a later sweep is lossy but the audit trail
    // in the store already recorded the attempt failure (core behavior).
    log(`extraction failed for ${sessionId}: ${String(err?.message || err)}`);
    return `failed: ${String(err?.message || err)}`;
  }
}

// Detached entry: node lib/extract-worker.mjs <payloadPath>
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    process.exit(2);
  }
  runExtractPhase(payloadPath)
    .catch((err) => log(`fatal: ${String(err?.message || err)}`))
    .finally(() => process.exit(0));
}
