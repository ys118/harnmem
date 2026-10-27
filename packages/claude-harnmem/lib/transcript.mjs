/**
 * Claude Code transcript JSONL -> core TranscriptMessage[].
 *
 * Tolerant by design: unknown line shapes are skipped, never fatal. Sidechain
 * (subagent) entries are excluded — only the main session is journaled, and
 * only the main session extracts (contract §5: subagents stay read-only).
 */

const MAX_MESSAGES = 400;
const MAX_TEXT_CHARS = 4000;

export function parseClaudeTranscript(raw) {
  const out = [];
  if (typeof raw !== "string" || raw.length === 0) return out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry.isSidechain === true) continue;
    const type = entry.type;
    if (type !== "user" && type !== "assistant") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    let text = "";
    if (typeof message.content === "string") {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      const parts = [];
      for (const block of message.content) {
        if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
      text = parts.join("\n");
    }
    text = text.trim();
    if (!text) continue;
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    out.push({ role: type, text, ...(Number.isFinite(ts) ? { ts } : {}) });
  }
  return out.slice(-MAX_MESSAGES);
}
