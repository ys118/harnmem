/**
 * Unit tests for the snapshot byte-stability protocol (08 §4), exercised
 * without a host or a real engine.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotManager } from "../dist/snapshot.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function logSink() {
  const entries = [];
  return {
    entries,
    debug(message, data) {
      entries.push({ level: "debug", message, data });
    },
    warn(message, data) {
      entries.push({ level: "warn", message, data });
    },
    error(message, data) {
      entries.push({ level: "error", message, data });
    },
    info(message, data) {
      entries.push({ level: "info", message, data });
    },
  };
}

function fakeEngine() {
  const calls = [];
  return {
    calls,
    async ensureContext(reason) {
      calls.push(reason);
      return { text: `block:${reason}:${calls.length}`, reason, snapshotAt: Date.now(), ids: [], tokensEstimate: 1 };
    },
  };
}

test("serves the primed snapshot without touching the engine", async () => {
  const engine = fakeEngine();
  const log = logSink();
  const manager = new SnapshotManager(() => engine, log, () => 1_000);
  manager.prime({ text: "warm", reason: "session_start", snapshotAt: 1_000, ids: [], tokensEstimate: 2 }, "session_start");
  await manager.ensureFresh("always");
  assert.deepEqual(engine.calls, []);
  assert.equal(manager.text(), "warm");
});

test("rebuilds only when dirty and reuses the new bytes afterwards", async () => {
  const engine = fakeEngine();
  const log = logSink();
  const manager = new SnapshotManager(() => engine, log, () => 1_000);
  manager.markDirty("memory_write");
  await manager.ensureFresh("always");
  await manager.ensureFresh("always");
  assert.deepEqual(engine.calls, ["memory_write"]);
  assert.equal(manager.text(), "block:memory_write:1");
  const rebuilt = log.entries.find((entry) => entry.message === "snapshot.rebuilt");
  assert.ok(rebuilt);
  assert.equal(rebuilt.data.reason, "memory_write");
});

test("a local day rollover triggers a day_rollover rebuild", async () => {
  const engine = fakeEngine();
  const log = logSink();
  let now = 1_000;
  const manager = new SnapshotManager(() => engine, log, () => now);
  manager.prime({ text: "day-one", reason: "session_start", snapshotAt: now, ids: [], tokensEstimate: 1 }, "session_start");
  await manager.ensureFresh("always");
  assert.deepEqual(engine.calls, []);
  now += DAY_MS;
  await manager.ensureFresh("always");
  assert.deepEqual(engine.calls, ["day_rollover"]);
});

test("a failing rebuild keeps the previous bytes (fail closed)", async () => {
  const log = logSink();
  const engine = {
    async ensureContext() {
      throw new Error("disk down");
    },
  };
  const manager = new SnapshotManager(() => engine, log, () => 1_000);
  manager.prime({ text: "keep-me", reason: "session_start", snapshotAt: 1_000, ids: [], tokensEstimate: 1 }, "session_start");
  manager.markDirty("manual");
  await manager.ensureFresh("always");
  assert.equal(manager.text(), "keep-me");
  const failed = log.entries.find((entry) => entry.message === "snapshot.failed");
  assert.ok(failed);
  assert.match(failed.data.error, /disk down/);
});

test("no engine means the empty snapshot", async () => {
  const log = logSink();
  const manager = new SnapshotManager(() => null, log, () => 1_000);
  assert.equal(manager.text(), "");
  await manager.ensureFresh("always");
  assert.equal(manager.text(), "");
});
