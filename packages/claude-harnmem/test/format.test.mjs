/**
 * Tool-output budget: every formatter (and the MCP textResult envelope) must
 * keep outputs far under Claude Code's 25k-token MAX_MCP_OUTPUT_TOKENS cap.
 * Regression for docs/design/09 §MCP: an adversarially large memory (up to the
 * 64KB content limit, or limit=50 hits) must never produce an oversized tool
 * result.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { formatRead, formatSearch, formatStats } from "../lib/format.mjs";

const BIG = "记忆内容压测。".repeat(12_000); // ~96KB of CJK, over the 64KB content cap

function mkHit(i, content) {
  return {
    id: `mem_test_${i}`,
    type: "project",
    category: "decision",
    scope: "project",
    status: "active",
    pinned: false,
    historical: false,
    title: `hit ${i}`,
    description: "d".repeat(3_000),
    snippet: content.slice(0, 500),
  };
}

test("formatSearch stays under the 12k-char tool budget with 50 pathological hits", () => {
  const result = {
    query: "压测",
    total: 50,
    abstained: false,
    results: Array.from({ length: 50 }, (_, i) => mkHit(i, BIG)),
    debug: { candidateCount: 9999, truncated: [], elapsedMs: 123, shards: ["harnmem-test"] },
  };
  const text = formatSearch(result);
  assert.ok(text.length <= 12_100, `search output ${text.length} chars exceeds budget`);
  assert.match(text, /…\[truncated \d+ chars\]/);
});

test("formatSearch survives a non-array debug.shards (vendor/core shape drift)", () => {
  const result = {
    query: "q",
    total: 1,
    abstained: false,
    results: [mkHit(0, "short content")],
    debug: { candidateCount: 1, truncated: [], elapsedMs: 1, shards: "harnmem-test" },
  };
  const text = formatSearch(result);
  assert.match(text, /shards=harnmem-test/);
});

test("formatRead stays under the budget for a 64KB memory and marks the cut", () => {
  const result = {
    record: {
      id: "mem_big",
      type: "project",
      category: "decision",
      scope: "project",
      status: "active",
      importance: 5,
      confidence: 0.7,
      pinned: false,
      title: "big",
      description: "d",
      content: BIG,
      created: 0,
      updated: 0,
      validFrom: 0,
    },
    backlinks: [],
    history: [],
  };
  const text = formatRead(result, "mem_big");
  assert.ok(text.length <= 12_100, `read output ${text.length} chars exceeds budget`);
  assert.match(text, /…\[truncated \d+ chars\]/);
});

test("formatStats stays under the budget for a store with hundreds of shards", () => {
  const stats = {
    version: "1",
    home: "C:/x/.harnmem",
    project: "p",
    index: { seq: 1, stale: false, builtAt: 0, sizeBytes: 1, overhead: 1.2 },
    shards: Array.from({ length: 400 }, (_, i) => ({
      name: `shard-${i}`,
      scope: "project",
      total: 10,
      active: 10,
      superseded: 0,
      archived: 0,
      pinned: 0,
      bytes: 1024,
    })),
    health: { overBudget: 0, duplicateCandidates: 0, orphans: 0, lastConsolidate: 0 },
    extraction: { pending: 0, failed: 0, skipReasons: {} },
  };
  const text = formatStats(stats);
  assert.ok(text.length <= 12_100, `stats output ${text.length} chars exceeds budget`);
});
