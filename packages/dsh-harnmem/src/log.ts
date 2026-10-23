/**
 * Adapter logger: forwards to `ctx.logger` and, when enabled, appends JSON
 * lines to `<home>/logs/dsh.jsonl` (the pi adapter's `pi.jsonl` counterpart).
 *
 * The silent-write incident was undiagnosable because DSH had no file sink at
 * all (docs/research/dsh-write-silence-2026-10-23.md §2). Logging must never
 * break the host, so every call is guarded and file writes are chained,
 * bounded and swallowed; `flush()` is awaited on plugin unload.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { HostLogger } from "./host.js";

export const LOG_PREFIX = "[dsh-harnmem]";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LoggerOptions {
  /** Absolute path of the JSONL sink; omit for a host-only logger. */
  file?: string;
  /** false disables the file sink entirely (`log: "off"`). */
  enabled?: boolean;
  /** Minimum level written to the file. Default "debug". */
  level?: LogLevel;
  /** Cap on queued-but-unwritten lines; beyond it, lines are dropped. */
  maxPending?: number;
}

export class Logger {
  private readonly sinkFile?: string;
  private readonly fileEnabled: boolean;
  private readonly fileLevel: LogLevel;
  private readonly maxPending: number;
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  private dirReady = false;

  constructor(
    private readonly sink?: HostLogger,
    readonly debugEnabled = false,
    options: LoggerOptions = {},
  ) {
    this.sinkFile = options.file;
    this.fileEnabled = options.file !== undefined && options.enabled !== false;
    this.fileLevel = options.level ?? "debug";
    this.maxPending = options.maxPending ?? 2048;
  }

  /** Path of the file sink, when one is configured. */
  get filePath(): string | undefined {
    return this.sinkFile;
  }

  debug(message: string, data?: unknown): void {
    this.emit("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.emit("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.emit("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.emit("error", message, data);
  }

  /** Resolve when every queued file line has been written (or dropped). */
  async flush(): Promise<void> {
    await this.chain;
  }

  private emit(level: LogLevel, message: string, data?: unknown): void {
    this.emitHost(level, message, data);
    this.emitFile(level, message, data);
  }

  private emitHost(level: LogLevel, message: string, data?: unknown): void {
    const sink = this.sink;
    if (!sink) return;
    const text = `${LOG_PREFIX} ${message}`;
    try {
      const fn = sink[level];
      if (typeof fn === "function") {
        if (data === undefined) fn.call(sink, text);
        else fn.call(sink, text, data);
        return;
      }
      // Older surfaces may only expose info/warn/error.
      const fallback = level === "debug" ? sink.info : undefined;
      if (typeof fallback === "function") {
        if (data === undefined) fallback.call(sink, text);
        else fallback.call(sink, text, data);
      }
    } catch {
      // Never throw into the host from a log statement.
    }
  }

  private emitFile(level: LogLevel, message: string, data?: unknown): void {
    const file = this.sinkFile;
    if (!file || !this.fileEnabled) return;
    if (LEVEL_RANK[level] < LEVEL_RANK[this.fileLevel] || this.pending >= this.maxPending) return;
    let line: string;
    try {
      const payload: Record<string, unknown> =
        typeof data === "object" && data !== null && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : data === undefined
            ? {}
            : { data };
      line = `${JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...payload })}\n`;
    } catch {
      return; // circular / non-serialisable data must never throw
    }
    this.pending += 1;
    this.chain = this.chain.then(async () => {
      try {
        if (!this.dirReady) {
          await fs.mkdir(path.dirname(file), { recursive: true });
          this.dirReady = true;
        }
        await fs.appendFile(file, line, "utf8");
      } catch {
        // file logging is best effort
      } finally {
        this.pending -= 1;
      }
    });
  }
}

/** Build a logger with an optional JSONL file sink. */
export function createLogger(options: LoggerOptions = {}, sink?: HostLogger): Logger {
  return new Logger(sink, options.level === "debug", options);
}

/** `<home>/logs/dsh.jsonl` — mirrors pi's `logFilePath`. */
export function logFilePath(home: string): string {
  return path.join(home, "logs", "dsh.jsonl");
}
