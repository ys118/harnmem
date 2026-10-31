/**
 * Non-blocking JSONL logger. Writes to `<harnmem home>/logs/omp.jsonl`.
 *
 * The engine never prints to stdout; this is the adapter-side audit sink.
 * All file I/O is chained and swallowed so logging can never break an omp turn.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** Resolve when every queued line has been written (or dropped). */
  flush(): Promise<void>;
}

export interface LoggerOptions {
  file: string;
  enabled: boolean;
  /** Minimum level that is written. */
  level: LogLevel;
  /** Cap queued-but-unwritten lines; beyond this, lines are dropped. */
  maxPending?: number;
}

export function createLogger(opts: LoggerOptions): Logger {
  const all: LogLevel = "debug";
  const maxPending = opts.maxPending ?? 2000;
  let chain: Promise<void> = Promise.resolve();
  let pending = 0;
  let dirReady = false;

  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (!opts.enabled || RANK[level] < RANK[opts.level] || pending >= maxPending) return;
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(data ?? {}) }) + "\n";
    } catch {
      return; // circular / non-serialisable data must never throw
    }
    pending += 1;
    chain = chain.then(async () => {
      try {
        if (!dirReady) {
          await fs.mkdir(path.dirname(opts.file), { recursive: true });
          dirReady = true;
        }
        await fs.appendFile(opts.file, line, "utf8");
      } catch {
        // audit logging is best effort
      } finally {
        pending -= 1;
      }
    });
  };

  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
    flush: () => chain.catch(() => undefined),
  };
}

export function logFilePath(home: string): string {
  return path.join(home, "logs", "omp.jsonl");
}
