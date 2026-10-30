/**
 * Injection truncation: the adapter caps `additional_context` at a fixed byte
 * budget and must truncate deterministically (same snapshot => same bytes),
 * line-aligned, with a marker the model can see.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MAX_INJECT_BYTES, TRUNCATION_MARKER, capBytes } from "../lib/cap.mjs";

test("short text passes through untouched", () => {
  const text = "## HarnMem memory\n- [project] one\n- [project] two";
  assert.equal(capBytes(text), text);
  assert.equal(capBytes(""), "");
});

test("text at or below the cap is unchanged", () => {
  const line = "x".repeat(99);
  const text = Array.from({ length: Math.floor(MAX_INJECT_BYTES / 100) }, () => line).join("\n");
  assert.ok(Buffer.byteLength(text, "utf8") <= MAX_INJECT_BYTES);
  assert.equal(capBytes(text), text);
});

test("oversized text is truncated line-aligned with the marker", () => {
  const text = Array.from({ length: 500 }, (_, i) => `- [project] record ${i} ${"detail ".repeat(4)}`).join("\n");
  assert.ok(Buffer.byteLength(text, "utf8") > MAX_INJECT_BYTES);
  const capped = capBytes(text);
  assert.ok(Buffer.byteLength(capped, "utf8") <= MAX_INJECT_BYTES, "cap respected");
  assert.ok(capped.endsWith(TRUNCATION_MARKER), "ends with marker");
  // Line-aligned: every kept line is a whole line from the original.
  const kept = capped.slice(0, -TRUNCATION_MARKER.length).split("\n");
  assert.deepEqual(kept, text.split("\n").slice(0, kept.length));
  assert.ok(kept.length > 0 && kept.length < 500, "partial content kept");
});

test("truncation is deterministic and never splits UTF-8 sequences", () => {
  const text = Array.from({ length: 400 }, (_, i) => `- 记忆 ${i} ${"内容".repeat(30)}`).join("\n");
  const first = capBytes(text);
  const second = capBytes(text);
  assert.equal(first, second);
  assert.doesNotThrow(() => Buffer.from(first, "utf8").toString("utf8"));
  assert.equal(Buffer.from(first, "utf8").toString("utf8"), first);
});

test("a custom budget is honoured and remains deterministic", () => {
  const text = "a".repeat(40) + "\n" + "b".repeat(40);
  const capped = capBytes(text, 200);
  assert.equal(capped, text, "text shorter than a custom budget passes through");
  // A budget too small for content plus the marker injects nothing rather
  // than overflowing the budget.
  assert.equal(capBytes(text, 30), "");
  assert.equal(capBytes(text, TRUNCATION_MARKER.length), "");
});
