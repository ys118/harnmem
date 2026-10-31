/**
 * In-memory transcript journal for session-end extraction.
 *
 * Fed by omp's `message_end` event, converted to the engine's
 * `TranscriptMessage` shape, and bounded so long sessions stay cheap.
 * Nothing is written to disk from here: the engine owns all storage.
 */

import type { TranscriptMessage } from "@harnmem/core";

type UnknownMessage = {
  role?: unknown;
  content?: unknown;
  toolName?: unknown;
  timestamp?: unknown;
};

export interface JournalOptions {
  maxMessages?: number;
  maxChars?: number;
  perMessageChars?: number;
}

const DEFAULTS: Required<JournalOptions> = {
  maxMessages: 240,
  maxChars: 160_000,
  perMessageChars: 4_000,
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

export class TranscriptJournal {
  private readonly opts: Required<JournalOptions>;
  private messages: TranscriptMessage[] = [];
  private chars = 0;

  constructor(options: JournalOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  get size(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages = [];
    this.chars = 0;
  }

  /** Convert + append one omp AgentMessage. Ignores system messages and noise. */
  add(message: unknown): void {
    const msg = (message ?? {}) as UnknownMessage;
    const role = msg.role;
    let normalized: TranscriptMessage | undefined;

    if (role === "user") {
      normalized = { role: "user", text: textOf(msg.content) };
    } else if (role === "assistant") {
      normalized = { role: "assistant", text: textOf(msg.content) };
    } else if (role === "toolResult" || role === "tool") {
      normalized = {
        role: "tool",
        text: textOf(msg.content),
        name: typeof msg.toolName === "string" ? msg.toolName : undefined,
      };
    }

    if (!normalized) return;
    normalized.text = normalized.text.trim();
    if (!normalized.text) return;
    if (normalized.text.length > this.opts.perMessageChars) {
      normalized.text = normalized.text.slice(0, this.opts.perMessageChars) + " …[truncated]";
    }
    if (typeof msg.timestamp === "number") normalized.ts = msg.timestamp;

    this.messages.push(normalized);
    this.chars += normalized.text.length;
    this.trim();
  }

  private trim(): void {
    while (this.messages.length > this.opts.maxMessages) {
      const dropped = this.messages.shift();
      if (dropped) this.chars -= dropped.text.length;
    }
    while (this.chars > this.opts.maxChars && this.messages.length > 1) {
      const dropped = this.messages.shift();
      if (dropped) this.chars -= dropped.text.length;
    }
  }

  /** Oldest first, defensive copy. */
  snapshot(): TranscriptMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }
}
