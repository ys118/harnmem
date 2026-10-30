/**
 * Cursor agent transcript JSONL -> core TranscriptMessage[].
 *
 * Cursor rewrites the transcript file for each conversation at
 * `~/.cursor/projects/<encoded-cwd>/agent-transcripts/<uuid>/<uuid>.jsonl`
 * (the hook payload carries the absolute path as `transcript_path`). Observed
 * line shapes on desktop 3.27.22:
 *
 *   {"role":"user","message":{"content":[{"type":"text","text":"<timestamp>…</timestamp>\n<user_query>\n…\n</user_query>"}]}}
 *   {"role":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
 *   {"type":"turn_ended","status":"success"}
 *
 * There are no tool_use / tool_result / thinking entries: tool activity only
 * exists in hooks, not in this file. The user turn text is wrapped in
 * `<timestamp>` and `<user_query>` tags, which are stripped here.
 *
 * Tolerant by design: unknown line shapes are skipped, never fatal.
 */

const MAX_MESSAGES = 400;
const MAX_TEXT_CHARS = 4000;

const TIMESTAMP_TAG = /<timestamp>[\s\S]*?<\/timestamp>/gi;
const USER_QUERY_TAG = /<\/?user_query>/gi;

function stripEnvelopes(text) {
  return text.replace(TIMESTAMP_TAG, "").replace(USER_QUERY_TAG, "").trim();
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

export function parseCursorTranscript(raw) {
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
    if (entry.type === "turn_ended") continue;
    const role = entry.role;
    if (role !== "user" && role !== "assistant") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    let text = stripEnvelopes(textFromContent(message.content));
    if (!text) continue;
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
    const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    out.push({ role, text, ...(Number.isFinite(ts) ? { ts } : {}) });
  }
  return out.slice(-MAX_MESSAGES);
}
