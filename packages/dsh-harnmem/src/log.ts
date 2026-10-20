/**
 * Thin logger over `ctx.logger`. Logging must never break the host, so every
 * call is guarded. Tests read these entries to observe rebuild reasons and
 * extraction outcomes.
 */

import type { HostLogger } from "./host.js";

export const LOG_PREFIX = "[dsh-harnmem]";

export class Logger {
  constructor(private readonly sink?: HostLogger, readonly debugEnabled = false) {}

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

  private emit(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): void {
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
}
