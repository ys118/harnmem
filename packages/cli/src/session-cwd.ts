/**
 * Legacy project-identity recovery.
 *
 * Sources of truth, in order of confidence:
 *  1. explicit `--path-map` entry (user-declared, highest);
 *  2. a real cwd recovered from the harness's own session log (zstd header for
 *     DSH, JSONL first line for pi) → run core-compatible detectProject;
 *  3. a path decoded from the legacy directory name, accepted only when that
 *     path exists on disk (directory-name encoding is ambiguous about `-`);
 *  4. the unresolved bucket — never silently assign the user scope.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

export interface RecoveredCwd {
  cwd: string;
  source: "session-log";
  sessionId?: string;
  createdAt?: number;
  file: string;
}

interface SessionHeader {
  type?: string;
  cwd?: string;
  id?: string;
  sessionId?: string;
  createdAt?: number;
  delegationDepth?: number;
}

function parseHeaderText(text: string): SessionHeader | null {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const trimmed = firstLine.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed) as SessionHeader;
  } catch {
    // fall back to targeted extraction from a partially framed header
    const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
    if (!cwd) return null;
    const id = /"id"\s*:\s*"([^"]+)"/.exec(text)?.[1];
    return { cwd: JSON.parse(`"${cwd}"`) as string, id };
  }
}

/** First zstd frame of a DSH session log holds the session header. */
export function readZstdHeader(file: string, maxBytes = 64 * 1024): SessionHeader | null {
  const fd = openSync(file, "r");
  try {
    const size = Math.min(statSync(file).size, maxBytes);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    let text: string;
    try {
      text = zstdDecompressSync(buf).toString("utf8");
    } catch {
      // Some logs need a frame boundary scan; try each magic offset.
      text = "";
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      let offset = 0;
      for (let attempt = 0; attempt < 64; attempt++) {
        const start = buf.indexOf(magic, offset);
        if (start === -1) break;
        try {
          text = zstdDecompressSync(buf.subarray(start)).toString("utf8");
          break;
        } catch {
          offset = start + 4;
        }
      }
      if (text === "") return null;
    }
    return parseHeaderText(text);
  } finally {
    closeSync(fd);
  }
}

function newestDirWithFile(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSyncSafe(dir);
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of entries) {
    const file = join(dir, name, "session.v4.jsonl.zstd");
    try {
      const s = statSync(file);
      if (!s.isFile()) continue;
      if (!best || s.mtimeMs > best.mtime) best = { file, mtime: s.mtimeMs };
    } catch {
      // not this shape
    }
  }
  return best?.file ?? null;
}

function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir);
}

/** Map DSH project-key directory name → recovered cwd, via its session logs. */
export async function readDshSessionCwds(sessionsRoot: string): Promise<Map<string, RecoveredCwd>> {
  const result = new Map<string, RecoveredCwd>();
  let keys: string[];
  try {
    keys = (await readdir(sessionsRoot)).filter((name) => !name.startsWith("."));
  } catch {
    return result;
  }
  for (const key of keys) {
    const file = newestDirWithFile(join(sessionsRoot, key));
    if (!file) continue;
    const header = readZstdHeader(file);
    if (!header?.cwd) continue;
    result.set(key, {
      cwd: header.cwd,
      source: "session-log",
      sessionId: header.sessionId ?? header.id,
      createdAt: header.createdAt,
      file,
    });
  }
  return result;
}

export interface PiSessionCwds {
  byProjectKey: Map<string, RecoveredCwd>;
  /** short session id (first 8 hex chars of the ULID-ish id) → cwd */
  byShortSession: Map<string, RecoveredCwd>;
  /** full session id → cwd */
  bySession: Map<string, RecoveredCwd>;
}

async function readJsonlFirstLine(file: string): Promise<SessionHeader | null> {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return parseHeaderText(buf.subarray(0, read).toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Scan the head of a JSONL log for the first record carrying a `cwd` string.
 * Claude Code writes the start-of-session record a few lines in, so reading only
 * the first line is not enough; the tail of the scanned window may cut a line in
 * half — that line fails to parse and is skipped.
 */
function readJsonlCwdScan(file: string, maxBytes: number): SessionHeader | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(maxBytes);
    const read = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, read).toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || !trimmed.includes('"cwd"')) continue;
      try {
        const parsed = JSON.parse(trimmed) as SessionHeader;
        if (typeof parsed.cwd === "string" && parsed.cwd.trim() !== "") return parsed;
      } catch {
        // partial line at the window edge or a non-JSON record
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * Map Claude Code's project directory name → recovered cwd.
 *
 * `<root>/projects/<slug>/<session>.jsonl`; the slug is a lossy encoding, but the
 * session records carry the real cwd. Only the first 256 KiB of each log is read.
 */
export async function readClaudeSessionCwds(
  projectsRoot: string,
  maxBytes = 262144,
): Promise<Map<string, RecoveredCwd>> {
  const out = new Map<string, RecoveredCwd>();
  let slugs: string[];
  try {
    slugs = (await readdir(projectsRoot)).filter((name) => !name.startsWith("."));
  } catch {
    return out;
  }
  for (const slug of slugs.sort()) {
    let files: string[];
    try {
      files = (await readdir(join(projectsRoot, slug))).filter((name) => name.endsWith(".jsonl")).sort();
    } catch {
      continue;
    }
    for (const name of files) {
      const file = join(projectsRoot, slug, name);
      const header = readJsonlCwdScan(file, maxBytes);
      if (!header?.cwd) continue;
      out.set(slug, {
        cwd: header.cwd,
        source: "session-log",
        sessionId: header.id ?? header.sessionId,
        createdAt: header.createdAt,
        file,
      });
      break;
    }
  }
  return out;
}

/** pi stores `sessions/<project-key>/<ts>_<id>.jsonl` with a `type: session` header. */
export async function readPiSessionCwds(sessionsRoot: string): Promise<PiSessionCwds> {
  const out: PiSessionCwds = { byProjectKey: new Map(), byShortSession: new Map(), bySession: new Map() };
  let keys: string[];
  try {
    keys = (await readdir(sessionsRoot)).filter((name) => !name.startsWith("."));
  } catch {
    return out;
  }
  for (const key of keys) {
    let files: string[];
    try {
      files = (await readdir(join(sessionsRoot, key))).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of files) {
      const file = join(sessionsRoot, key, name);
      const header = await readJsonlFirstLine(file);
      if (!header?.cwd) continue;
      const recovered: RecoveredCwd = {
        cwd: header.cwd,
        source: "session-log",
        sessionId: header.id ?? header.sessionId,
        createdAt: header.createdAt,
        file,
      };
      const existing = out.byProjectKey.get(key);
      if (!existing || (recovered.createdAt ?? 0) > (existing.createdAt ?? 0)) out.byProjectKey.set(key, recovered);
      const sessionId = recovered.sessionId;
      if (sessionId) {
        out.bySession.set(sessionId, recovered);
        const bare = sessionId.replace(/-/g, "");
        if (bare.length >= 8) out.byShortSession.set(bare.slice(0, 8), recovered);
      }
    }
  }
  return out;
}

/**
 * Reverse the `--C-Users-me-example-project--` encoding into a candidate path.
 * Returned value is a guess only; callers must require existsSync() before use.
 */
export function decodeLegacyDirName(name: string): string | null {
  const match = /^--(.+)--$/.exec(name);
  if (!match) return null;
  let body = match[1] ?? "";
  let drive: string | null = null;
  const driveMatch = /^([A-Za-z])-(.*)$/.exec(body);
  if (driveMatch) {
    drive = driveMatch[1] ?? null;
    body = driveMatch[2] ?? "";
  }
  const parts = body.split("-").filter((p) => p !== "");
  if (parts.length === 0) return null;
  if (drive) {
    return `${drive.toUpperCase()}:\\${parts.join("\\")}`;
  }
  return `/${parts.join("/")}`;
}

/** Load `--path-map` JSON: `{ "<legacy key>": "<projectId|path>" }` or `{ map: {...} }`. */
export async function readPathMap(file: string): Promise<Record<string, string>> {
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const map = (parsed as { map?: unknown }).map ?? parsed;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    throw new Error(`invalid --path-map ${file}: expected a JSON object of key → projectId|path`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
  }
  return out;
}

/** True when a path exists and is a directory (used to validate decoded names). */
export function isExistingDir(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export { existsSync };
