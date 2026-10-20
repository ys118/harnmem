/**
 * Incremental transcript digest for session-end extraction (08 §6).
 *
 * The adapter accumulates `session/event` payloads instead of replaying all
 * session events at dispose: user/assistant texts and tool names only, bounded
 * to 200 entries and 2 KB per entry. Core enforces the extraction gates
 * (minimum user messages, digest size).
 */

import type { TranscriptMessage } from "@harnmem/core";

export const MAX_DIGEST_ENTRIES = 200;
export const MAX_ENTRY_CHARS = 2000;

export interface DigestItem {
  role: TranscriptMessage["role"];
  text: string;
  name?: string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Extract plain text from the many content shapes a host message can use. */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      const text = textFromContent(item);
      if (text) parts.push(text);
    }
    return parts.join("\n");
  }
  if (typeof content === "object" && content !== null) {
    const record = content as Record<string, unknown>;
    if (typeof record["text"] === "string") return record["text"];
    if (typeof record["content"] === "string") return record["content"];
    if (Array.isArray(record["content"])) return textFromContent(record["content"]);
    if (typeof record["message"] === "object" && record["message"] !== null) {
      return textFromContent(record["message"]);
    }
    return "";
  }
  return "";
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Normalize one `session/event` payload into a digest item (or null). */
export function digestFromEvent(event: unknown): DigestItem | null {
  if (typeof event !== "object" || event === null) return null;
  const record = event as Record<string, unknown>;
  const type = readString(record, "type");
  const data = record["data"];
  const dataRecord = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
  switch (type) {
    case "user/message": {
      const source = dataRecord?.["source"];
      const kind = typeof source === "object" && source !== null ? (source as Record<string, unknown>)["kind"] : undefined;
      // Only a real user prompt counts; tool results and system reminders do not.
      if (kind !== undefined && kind !== "user") return null;
      if (kind === undefined && dataRecord?.["role"] !== undefined && dataRecord["role"] !== "user") return null;
      const text = textFromContent(dataRecord?.["message"] ?? dataRecord?.["content"] ?? data);
      if (!text.trim()) return null;
      return { role: "user", text: truncate(text, MAX_ENTRY_CHARS) };
    }
    case "assistant/message": {
      const text = textFromContent(dataRecord?.["message"] ?? dataRecord?.["content"] ?? data);
      if (!text.trim()) return null;
      return { role: "assistant", text: truncate(text, MAX_ENTRY_CHARS) };
    }
    case "tool/call": {
      const tool = dataRecord?.["tool"];
      const toolRecord = typeof tool === "object" && tool !== null ? (tool as Record<string, unknown>) : null;
      const name = readString(dataRecord, "name") ?? readString(dataRecord, "toolName") ?? readString(toolRecord, "name");
      if (!name) return null;
      // Tool name only: arguments can be large and are not needed for extraction.
      return { role: "tool", text: name, name };
    }
    default:
      return null;
  }
}

export class TranscriptDigest {
  private readonly items: DigestItem[] = [];

  add(item: DigestItem): void {
    if (!item.text.trim()) return;
    if (this.items.length >= MAX_DIGEST_ENTRIES) this.items.shift();
    this.items.push({ ...item, text: truncate(item.text, MAX_ENTRY_CHARS) });
  }

  addUser(text: string): void {
    this.add({ role: "user", text });
  }

  addAssistant(text: string): void {
    this.add({ role: "assistant", text });
  }

  addTool(name: string): void {
    this.add({ role: "tool", text: name, name });
  }

  get size(): number {
    return this.items.length;
  }

  userMessages(): number {
    return this.items.filter((item) => item.role === "user").length;
  }

  snapshot(): TranscriptMessage[] {
    return this.items.map((item) => {
      const message: TranscriptMessage = { role: item.role, text: item.text };
      if (item.name) message.name = item.name;
      return message;
    });
  }

  clear(): void {
    this.items.length = 0;
  }
}
