/**
 * Grok session transcript parsing for HarnMem's SessionEnd extraction.
 *
 * Grok writes two JSONL streams under
 * `~/.grok/sessions/<urlencoded-cwd>/<uuidv7>/` (17-sessions.md):
 *  - `chat_history.jsonl` — the raw chat messages sent to the model. This is
 *    the preferred source: `type` is user/assistant/system/reasoning, real
 *    user turns carry a numeric `prompt_index`, and machine-injected reminders
 *    carry a `synthetic_reason` (probe-ground-truthed in
 *    docs/research/grok-plugin.md §4.2).
 *  - `updates.jsonl` — the ACP session update stream. This is what
 *    `transcriptPath` points at (25-status-line.md:91): chunk-oriented
 *    `session/update` records that must be reassembled by role.
 *
 * Both parsers are tolerant: malformed lines, unknown roles and missing text
 * are skipped, never thrown. Output is capped so a huge session cannot blow up
 * the extraction prompt.
 */

export const MAX_MESSAGES = 400;
export const MAX_TEXT_CHARS = 4_000;

function clipText(text) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length <= MAX_TEXT_CHARS ? trimmed : trimmed.slice(0, MAX_TEXT_CHARS);
}

function isTextBlock(block) {
  return block && typeof block === "object" && block.type === "text" && typeof block.text === "string";
}

function contentToText(content) {
  if (typeof content === "string") return content;
  // chat_history entries use an array of blocks; ACP update.content is a single
  // block object ({type:"text",text:"..."}).
  if (isTextBlock(content)) return content.text;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (isTextBlock(block)) parts.push(block.text);
  }
  return parts.join("\n");
}

function toMessage(role, text, timestamp) {
  const clipped = clipText(text);
  if (!clipped) return undefined;
  const ts =
    typeof timestamp === "string" ? Date.parse(timestamp) : typeof timestamp === "number" ? timestamp : Number.NaN;
  return { role, text: clipped, ...(Number.isFinite(ts) ? { ts } : {}) };
}

function capMessages(messages) {
  return messages.slice(-MAX_MESSAGES);
}

/**
 * Parse `chat_history.jsonl`.
 *
 * Real user turns are identified by a numeric `prompt_index`; when an older
 * Grok build did not write it, fall back to "user entries without a
 * synthetic_reason". Machine reminders (`<system-reminder>` for skills,
 * MCP servers, tool schemas, …) are always dropped so they never pollute the
 * extraction prompt.
 */
export function parseGrokChatHistory(raw) {
  const collected = [];
  let sawPromptIndex = false;
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const type = entry.type;
    if (type !== "user" && type !== "assistant") continue;
    const text = contentToText(entry.content);
    if (!text) continue;
    const hasPromptIndex = type === "user" && Number.isFinite(entry.prompt_index);
    if (hasPromptIndex) sawPromptIndex = true;
    collected.push({
      type,
      text,
      hasPromptIndex,
      synthetic: typeof entry.synthetic_reason === "string" && entry.synthetic_reason.length > 0,
      timestamp: entry.timestamp,
    });
  }

  const messages = [];
  for (const item of collected) {
    if (item.type === "user") {
      if (item.synthetic) continue;
      if (sawPromptIndex && !item.hasPromptIndex) continue;
      const msg = toMessage("user", item.text, item.timestamp);
      if (msg) messages.push(msg);
    } else {
      const msg = toMessage("assistant", item.text, item.timestamp);
      if (msg) messages.push(msg);
    }
  }
  return capMessages(messages);
}

/**
 * Parse `updates.jsonl` (fallback when chat_history.jsonl is missing).
 *
 * Keeps only text chunks of user/assistant turns and concatenates consecutive
 * chunks into one message; thinking chunks, tool calls and ACP bookkeeping are
 * dropped.
 */
export function parseGrokUpdates(raw) {
  const messages = [];
  let currentRole;
  let buffer = "";

  const flush = () => {
    if (currentRole && buffer) {
      const msg = toMessage(currentRole, buffer, undefined);
      if (msg) messages.push(msg);
    }
    currentRole = undefined;
    buffer = "";
  };

  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const update = record?.params?.update;
    if (!update || typeof update !== "object") continue;
    const kind = update.sessionUpdate;
    const role = kind === "user_message_chunk" ? "user" : kind === "agent_message_chunk" ? "assistant" : undefined;
    if (!role) continue;
    const text = contentToText(update.content);
    if (!text) continue;
    if (currentRole && currentRole !== role) flush();
    currentRole = role;
    buffer += text;
    if (buffer.length > MAX_TEXT_CHARS * 4) flush(); // hard bound while streaming
  }
  flush();
  return capMessages(messages);
}
