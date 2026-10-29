/**
 * Codex rollout parsing and resolution for session-end extraction.
 *
 * Codex persists every session (interactive and `codex exec`) as JSONL under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`
 * (probe-verified 2026-10-28, docs/research/codex-plugin.md §4). Line shapes
 * we consume:
 *   {"timestamp": "...", "type": "response_item",
 *    "payload": {"type": "message", "role": "user"|"assistant"|"developer",
 *                "content": [{"type": "input_text"|"output_text", "text": "..."}]}}
 *
 * Harness-injected user turns arrive as XML-tagged envelopes
 * (<environment_context>, <user_instructions>, <skills_instructions>, ...);
 * they are host boilerplate, never user intent, and are dropped before the
 * digest. The same TranscriptMessage shape as the Claude adapter is produced
 * (core's extract phase is transcript-format agnostic).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** Per-message character clip (same budget as the Claude adapter). */
const CLIP_CHARS = 4000;
/** Keep only the last N messages (same budget as the Claude adapter). */
const TAIL = 400;

/**
 * User-turn prefixes that are harness injections, not user intent. Matched on
 * the trimmed text start. The list mirrors what the probe saw in real
 * rollouts plus the documented Codex instruction envelopes.
 */
const HARNESS_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<permissions ", // trailing space is intentional: the tag carries attributes (<permissions sandbox_mode=...>)
  "<apps_instructions>",
  "<skills_instructions>",
  "<plugins_instructions>",
  "<recommended_plugins>",
  "<turn_context>",
  "<user_shell_command>",
];

function isHarnessBoilerplate(text) {
  const t = text.trimStart();
  if (!t) return true;
  return HARNESS_PREFIXES.some((p) => t.startsWith(p));
}

function joinContent(content, textType) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === textType && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Parse a rollout JSONL string into TranscriptMessage[]
 * ({ role: "user"|"assistant", text: string, ts: epochMs|null }) — the field
 * is `text`, matching core's SessionEndInput contract. Malformed lines are
 * skipped, never fatal. Same budgets as Claude: 4000-char clip per message,
 * last 400 messages.
 */
export function parseCodexTranscript(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const messages = [];
  // Filter FIRST, tail by message count second: rollouts interleave many
  // non-message lines (event_msg, turn_context, token counts), so tailing the
  // raw lines could keep only boilerplate and drop every real message.
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || entry.type !== "response_item") continue;
    const payload = entry.payload;
    if (!payload || payload.type !== "message") continue;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = joinContent(payload.content, role === "user" ? "input_text" : "output_text");
    if (!text) continue;
    if (role === "user" && isHarnessBoilerplate(text)) continue;
    const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    messages.push({
      role,
      text: text.length > CLIP_CHARS ? text.slice(0, CLIP_CHARS) : text,
      ts: Number.isFinite(ts) ? ts : null,
    });
  }
  return messages.length > TAIL ? messages.slice(-TAIL) : messages;
}

function sanitizeSessionId(sessionId) {
  return String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "");
}

function localDateDir(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return path.join(String(y), m, d);
}

/**
 * Resolve the rollout file for a Codex thread id. Sessions may cross midnight
 * or be resumed later, so today's and yesterday's local date directories are
 * both scanned and the newest match wins. Returns undefined when not found —
 * extraction then degrades to an audited skip, never an error.
 */
export function findRolloutFile(codexHome, sessionId, now = new Date()) {
  const id = sanitizeSessionId(sessionId);
  if (!id || !codexHome) return undefined;
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) return undefined;
  const candidates = [];
  // Date-component arithmetic (not ms offsets): adding 86_400_000 ms drifts
  // across DST boundaries, which would scan the wrong date directories.
  const shiftLocal = (base, offsetDays) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
  for (const offsetDays of [0, -1]) {
    const dir = path.join(sessionsRoot, localDateDir(shiftLocal(now, offsetDays)));
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      // rollout-2026-10-28T11-00-04-<uuid>.jsonl — match on the trailing id
      if (name.startsWith("rollout-") && name.endsWith(`-${id}.jsonl`)) {
        candidates.push(path.join(dir, name));
      }
    }
  }
  if (candidates.length === 0) return undefined;
  // Lexical order == chronological order for the ISO-ish timestamp in the
  // filename; the last candidate is the newest.
  candidates.sort();
  return candidates[candidates.length - 1];
}

export function defaultCodexHome(env = process.env) {
  const fromEnv = env.CODEX_HOME && env.CODEX_HOME.trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(homedir(), ".codex");
}

/**
 * Rollout file stem: rollout-<YYYY-MM-DDThh-mm-ss>-<threadId>.jsonl → threadId.
 * The timestamp shape is fixed (19 chars, dash-separated), so the thread id is
 * everything after it — the id itself contains dashes (UUIDs), making
 * lastIndexOf unusable here.
 */
const ROLLOUT_NAME_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/;

export function threadIdFromFileName(name) {
  const m = ROLLOUT_NAME_RE.exec(path.basename(name));
  return m ? sanitizeSessionId(m[1]) || undefined : undefined;
}

/**
 * Recent rollout files for backfill, newest first. Scans the last three local
 * date directories (a session can idle over a weekend) and excludes the
 * current thread — the live rollout is not finished and must never be
 * extracted. Returns [{ file, threadId, mtimeMs }], at most `limit` entries.
 */
export function findRecentRollouts(codexHome, excludeSessionId, now = new Date(), limit = 5) {
  if (!codexHome) return [];
  const sessionsRoot = path.join(codexHome, "sessions");
  if (!existsSync(sessionsRoot)) return [];
  const exclude = sanitizeSessionId(excludeSessionId);
  const shiftLocal = (base, offsetDays) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
  const found = [];
  for (const offsetDays of [0, -1, -2]) {
    const dir = path.join(sessionsRoot, localDateDir(shiftLocal(now, offsetDays)));
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const threadId = threadIdFromFileName(name);
      if (!threadId || threadId === exclude) continue;
      const full = path.join(dir, name);
      try {
        found.push({ file: full, threadId, mtimeMs: statSync(full).mtimeMs, name });
      } catch {
        // vanished between readdir and stat — skip
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return typeof limit === "number" && limit > 0 ? found.slice(0, limit) : found;
}
