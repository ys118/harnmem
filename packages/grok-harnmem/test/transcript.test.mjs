/**
 * Grok transcript parsing: chat_history.jsonl is the primary extraction
 * source, updates.jsonl the fallback. Shapes are ground-truthed from a real
 * Grok 1.0.70 probe home (docs/research/grok-plugin.md §4.2).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_MESSAGES, MAX_TEXT_CHARS, parseGrokChatHistory, parseGrokUpdates } from "../lib/transcript.mjs";

const CHAT_HISTORY = [
  { type: "system", content: "You are Grok." },
  { type: "user", content: [{ type: "text", text: "<rules>workspace rules</rules>" }] },
  { type: "user", content: [{ type: "text", text: "<user_query>明天提交信息用中文</user_query>" }], prompt_index: 0 },
  {
    type: "user",
    content: [{ type: "text", text: "<system-reminder>MCP servers connected</system-reminder>" }],
    synthetic_reason: "mcp_servers",
  },
  { type: "assistant", content: "好的，记下了。", model_id: "grok-test" },
  { type: "reasoning", id: "", summary: [{ type: "summary_text", text: "thinking..." }] },
];

function lines(records) {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

test("chat_history: keeps real turns, drops rules/reasoning/synthetic reminders", () => {
  const messages = parseGrokChatHistory(lines(CHAT_HISTORY));
  assert.deepEqual(messages, [
    { role: "user", text: "<user_query>明天提交信息用中文</user_query>" },
    { role: "assistant", text: "好的，记下了。" },
  ]);
});

test("chat_history without prompt_index falls back to non-synthetic user turns", () => {
  const legacy = [
    { type: "system", content: "You are Grok." },
    { type: "user", content: [{ type: "text", text: "旧版本没有 prompt_index" }] },
    { type: "user", content: [{ type: "text", text: "<system-reminder>skills</system-reminder>" }], synthetic_reason: "skills" },
    { type: "assistant", content: "收到" },
  ];
  const messages = parseGrokChatHistory(lines(legacy));
  assert.deepEqual(messages, [
    { role: "user", text: "旧版本没有 prompt_index" },
    { role: "assistant", text: "收到" },
  ]);
});

test("updates fallback reassembles text chunks by role and ignores thinking/tools", () => {
  const records = [
    { timestamp: 1, method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "请" } } } },
    { timestamp: 1, method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "记住偏好。" } } } },
    { timestamp: 1, method: "_x.ai/session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "内部推理" } } } },
    { timestamp: 1, method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "好" } } } },
    { timestamp: 1, method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "的。" } } } },
    { timestamp: 1, method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "tool_call", toolCallId: "t1" } } },
  ];
  const messages = parseGrokUpdates(lines(records));
  assert.deepEqual(messages, [
    { role: "user", text: "请记住偏好。" },
    { role: "assistant", text: "好的。" },
  ]);
});

test("both parsers are tolerant of malformed lines and cap volume", () => {
  const noisy = "not json\n\n" + lines([{ type: "user", content: "x".repeat(10_000), prompt_index: 0 }]);
  const messages = parseGrokChatHistory(noisy);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text.length, MAX_TEXT_CHARS);

  const many = lines(
    Array.from({ length: MAX_MESSAGES + 50 }, (_, i) => ({
      type: "assistant",
      content: `assistant ${i}`,
    })),
  );
  assert.equal(parseGrokChatHistory(many).length, MAX_MESSAGES);

  assert.deepEqual(parseGrokChatHistory(""), []);
  assert.deepEqual(parseGrokUpdates(""), []);
  assert.deepEqual(parseGrokChatHistory("{}"), []);
});
