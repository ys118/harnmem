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

export const PAYLOAD_TTL_MS = 60 * 60 * 1000; // 1 h, same as the Claude adapter

/**
 * Payload directory. HARNMEM_PAYLOAD_DIR overrides the default so concurrent
 * test runs (or sandboxes) never share one directory — a sweep from one run
 * would otherwise delete another run's in-flight payloads.
 */
export function payloadDir(env = process.env) {
  const override = typeof env.HARNMEM_PAYLOAD_DIR === "string" && env.HARNMEM_PAYLOAD_DIR;
  return override || path.join(tmpdir(), "harnmem-codex");
}

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

/**
 * Backfill cursor: the name of the newest rollout already extracted by the
 * session-start backfill. One global high-water mark (rollout file names sort
 * chronologically), stored under the harness home so it survives reboots.
 * A read-modify-write race between concurrent workers can at worst duplicate
 * one journal — core's write dedup absorbs that, so no locking is needed.
 */
export function backfillMarkerPath(home) {
  return path.join(home, "state", "codex-backfill-marker.json");
}

export function readBackfillMarker(home) {
  try {
    const raw = JSON.parse(readFileSync(backfillMarkerPath(home), "utf8"));
    return typeof raw?.lastFile === "string" ? raw.lastFile : "";
  } catch {
    return "";
  }
}

export function writeBackfillMarker(home, fileName) {
  try {
    const file = backfillMarkerPath(home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ lastFile: fileName, ts: new Date().toISOString() }), "utf8");
  } catch (err) {
    log(`backfill marker update failed: ${String(err?.message || err)}`);
  }
}

/** Lexical rollout-name comparison proxy: true when a is newer than b. */
export function isNewerRolloutName(a, b) {
  return !b || a > b;
}

/** Persist one session-end payload; returns the file path. */
export function writePayload(payload, dir = payloadDir()) {
  mkdirSync(dir, { recursive: true });
  // pid + random suffix: two ends of the same session can land in the same
  // millisecond (sync mode), and a colliding name would silently overwrite.
  const file = path.join(
    dir,
    `session-end-${safeId(payload.sessionId)}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  writeFileSync(file, JSON.stringify(payload), "utf8");
  return file;
}

/** Delete payload files older than the TTL (crashed workers, skipped ends). */
export function sweepStalePayloads(dir = payloadDir(), now = Date.now()) {
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
    env,
  });
  child.on("error", (err) => {
    // Spawn failures are rare but must not be fully silent: the payload stays
    // for the TTL sweep, and this line explains why nothing was extracted.
    log(`detached spawn failed for ${payloadPath}: ${String(err?.message || err)} (payload kept for sweep)`);
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
    let outcomeSuffix = "";
    const rollout = findRolloutFile(codexHome, sessionId);
    let raw = "";
    if (rollout) {
      try {
        raw = readFileSync(rollout, "utf8");
      } catch (err) {
        if (err && err.code === "ENOENT") {
          // The file vanished between find and read (user cleanup): degrade to
          // the audited "no rollout" skip, not a failure.
          raw = "";
          outcomeSuffix = " (rollout not found)";
        } else {
          throw err;
        }
      }
    }
    const messages = parseCodexTranscript(raw);
    const settings = resolveSettings(typeof cwd === "string" && cwd ? cwd : process.cwd(), process.env);
    // A payload may pin the store home explicitly: the detached worker does not
    // always inherit the server env (HARNMEM_HOME can be lost between
    // processes), and the session cwd may resolve to a different project.
    if (typeof payload.harnmemHome === "string" && payload.harnmemHome) {
      settings.home = payload.harnmemHome;
    }
    if (settings.enabled === false) {
      // Advance the cursor even on skip: a disabled store must not re-queue
      // the same rollouts on every future session start (payloads are deleted
      // here, so the cursor is the only progress record).
      if (payload.reason === "backfill" && typeof payload.rolloutName === "string") {
        const home = payload.harnmemHome || settings.home;
        if (home && isNewerRolloutName(payload.rolloutName, readBackfillMarker(home))) {
          writeBackfillMarker(home, payload.rolloutName);
        }
      }
      rmSync(payloadPath, { force: true });
      return "skipped: harnmem disabled";
    }
    const eng = await openEngine(settings, { sessionId, cwd, readOnly: false });
    let outcome;
    try {
      const result = await eng.sessionEnd({
        sessionId,
        cwd,
        reason: payload.reason === "backfill" ? "backfill" : "session_end",
        messages,
      });
      const added = Array.isArray(result?.added) && result.added.length ? ` added:${result.added.length}` : "";
      outcome = result?.status ? `${result.status}${added}` : "done";
      // Surface why nothing was extracted (skip reason or failure detail).
      const detail = result?.error || result?.skipReason;
      if (detail) outcome += ` (${detail})`;
    } finally {
      await eng.close().catch(() => {});
    }
    // Advance the backfill cursor only after a successful pass so a crashed
    // worker leaves the payload for a retry and the cursor untouched. The
    // queuing side pins the marker home (payload.harnmemHome): the previous
    // session's cwd may resolve to a different project home, and the cursor
    // must live in exactly one store.
    if (payload.reason === "backfill" && typeof payload.rolloutName === "string") {
      const home = payload.harnmemHome || settings.home;
      if (home && isNewerRolloutName(payload.rolloutName, readBackfillMarker(home))) {
        writeBackfillMarker(home, payload.rolloutName);
      }
    }
    outcome += outcomeSuffix;
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
