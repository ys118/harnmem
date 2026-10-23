/**
 * Digest window tests: a tool-heavy DSH session must never push real user
 * prompts out of the 200-entry ring, or extraction always skips with
 * `too_few_messages` (docs/research/dsh-write-silence-2026-10-23.md §2.2).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_DIGEST_ENTRIES, TranscriptDigest, digestFromEvent } from "../dist/digest.js";

function userEvent(text) {
  return {
    type: "user/message",
    data: { source: { kind: "user" }, message: { role: "user", content: [{ type: "text", text }] } },
  };
}

function toolEvent(name) {
  return { type: "tool/call", data: { name } };
}

test("user prompts survive a tool-heavy digest window", () => {
  const digest = new TranscriptDigest();
  digest.add(digestFromEvent(userEvent("first prompt")));
  for (let index = 0; index < MAX_DIGEST_ENTRIES * 2; index += 1) {
    digest.add(digestFromEvent(toolEvent(`tool_${index}`)));
  }
  assert.equal(digest.size, MAX_DIGEST_ENTRIES);
  assert.equal(digest.userMessages(), 1);
  assert.ok(
    digest.snapshot().some((message) => message.role === "user" && message.text === "first prompt"),
    "the original prompt is still in the window",
  );
});

test("later user prompts are preserved and trimmed to MAX_ENTRY_CHARS", () => {
  const digest = new TranscriptDigest();
  for (let index = 0; index < MAX_DIGEST_ENTRIES + 10; index += 1) {
    digest.add(digestFromEvent(toolEvent(`tool_${index}`)));
  }
  digest.add(digestFromEvent(userEvent("second prompt")));
  digest.add(digestFromEvent(userEvent("x".repeat(5000))));
  assert.equal(digest.userMessages(), 2);
  const texts = digest.snapshot().filter((message) => message.role === "user").map((message) => message.text);
  assert.ok(texts.includes("second prompt"));
  assert.ok(texts.every((text) => text.length <= 2000));
});

test("when only prompts exist, the oldest prompt is evicted last", () => {
  const digest = new TranscriptDigest();
  for (let index = 0; index < MAX_DIGEST_ENTRIES + 1; index += 1) {
    digest.addUser(`prompt ${index}`);
  }
  assert.equal(digest.size, MAX_DIGEST_ENTRIES);
  assert.equal(digest.userMessages(), MAX_DIGEST_ENTRIES);
  assert.equal(digest.snapshot()[0].text, "prompt 1");
  assert.equal(digest.snapshot()[MAX_DIGEST_ENTRIES - 1].text, `prompt ${MAX_DIGEST_ENTRIES}`);
});
