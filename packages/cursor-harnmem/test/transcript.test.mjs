import assert from "node:assert/strict";
import test from "node:test";

import { parseCursorTranscript } from "../lib/transcript.mjs";

const userLine = (text) => JSON.stringify({ role: "user", message: { content: [{ type: "text", text }] } });
const assistantLine = (text) => JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text }] } });

test("parses the Cursor transcript shape and strips prompt envelopes", () => {
  const raw = [
    userLine("<timestamp>Friday, Oct 30, 2026, 4:22 PM (UTC+8)</timestamp>\n<user_query>\nfix the build\n</user_query>"),
    assistantLine("Looking at the logs."),
    JSON.stringify({ type: "turn_ended", status: "success" }),
  ].join("\n");
  const messages = parseCursorTranscript(raw);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "fix the build", "timestamp/user_query envelopes are stripped");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].text, "Looking at the logs.");
});

test("skips unknown lines, tool blocks and empty texts; tolerates string content", () => {
  const raw = [
    "not json",
    JSON.stringify({ type: "turn_ended", status: "success" }),
    JSON.stringify({ role: "user", message: { content: [{ type: "tool_use", name: "Read" }] } }),
    JSON.stringify({ role: "user", message: { content: "plain string content" } }),
    JSON.stringify({ role: "assistant", message: { role: "assistant" } }),
    "",
  ].join("\n");
  const messages = parseCursorTranscript(raw);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "plain string content");
});

test("clips per-message text and caps the tail to 400 messages", () => {
  const big = "x".repeat(9000);
  const raw = Array.from({ length: 500 }, (_, i) => userLine(`${i}:${big}`)).join("\n");
  const messages = parseCursorTranscript(raw);
  assert.equal(messages.length, 400, "tail cap 400 messages");
  assert.ok(messages[0].text.length <= 4000, "per-message clip 4000");
  assert.ok(messages.at(-1).text.startsWith("499:"), "keeps the newest messages");
});

test("non-string input yields an empty list", () => {
  assert.deepEqual(parseCursorTranscript(""), []);
  assert.deepEqual(parseCursorTranscript(undefined), []);
});
