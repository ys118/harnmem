import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { findRecentRollouts, threadIdFromFileName } from "../lib/rollout.mjs";
import { backfillMarkerPath, payloadDir, readBackfillMarker, runExtractPhase, writePayload } from "../lib/extract-worker.mjs";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpPath = path.join(pkgRoot, "mcp", "mcp.mjs");
const CWD = process.cwd();

const NOW = new Date();

function stamp(d) {
  return {
    y: String(d.getFullYear()),
    m: String(d.getMonth() + 1).padStart(2, "0"),
    d: String(d.getDate()).padStart(2, "0"),
  };
}

function seedRollout(codexHome, threadId, ageDays, minute) {
  const t = stamp(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - ageDays));
  const dayDir = path.join(codexHome, "sessions", t.y, t.m, t.d);
  mkdirSync(dayDir, { recursive: true });
  const fileStamp = `${t.y}-${t.m}-${t.d}T10-${String(minute).padStart(2, "0")}-00`;
  const name = `rollout-${fileStamp}-${threadId}.jsonl`;
  const body = [
    JSON.stringify({ timestamp: `${t.y}-${t.m}-${t.d}T02:00:00.000Z`, type: "session_meta", payload: { id: threadId } }),
    JSON.stringify({
      timestamp: `${t.y}-${t.m}-${t.d}T02:01:00.000Z`,
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `backfill probe ${threadId}` }] },
    }),
  ].join("\n");
  writeFileSync(path.join(dayDir, name), body, "utf8");
  return name;
}

function cleanPayloadDir(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) rmSync(path.join(dir, name), { force: true });
}

test("threadIdFromFileName: extracts and sanitizes the trailing id", () => {
  assert.equal(threadIdFromFileName("rollout-2026-10-29T10-00-00-01a1879d-be37.jsonl"), "01a1879d-be37");
  assert.equal(threadIdFromFileName("not-a-rollout.jsonl"), undefined);
  assert.equal(threadIdFromFileName("rollout-bad.jsonl"), undefined);
});

test("findRecentRollouts: newest first, excludes the live thread, respects limit", () => {
  const codexHome = mkdtempSync(path.join(os.tmpdir(), "harnmem-cx-bf-list-"));
  try {
    const oldName = seedRollout(codexHome, "thread-old-aaaa", 2, 5);
    const newName = seedRollout(codexHome, "thread-new-bbbb", 0, 7);
    seedRollout(codexHome, "thread-live-cccc", 0, 9);

    const all = findRecentRollouts(codexHome, "thread-live-cccc", NOW);
    assert.deepEqual(
      all.map((c) => c.threadId),
      ["thread-new-bbbb", "thread-old-aaaa"],
      "newest first and the live thread excluded",
    );
    assert.equal(all[0].name, newName);
    assert.equal(all[1].name, oldName);

    const one = findRecentRollouts(codexHome, "thread-live-cccc", NOW, 1);
    assert.equal(one.length, 1);
    assert.equal(one[0].threadId, "thread-new-bbbb");
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test("backfill worker: journals the previous session and advances the marker", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-bf-home-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-bf-code-"));
  const payloads = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-bf-pay-"));
  try {
    const name = seedRollout(codexHome, "thread-backfill-dddd", 0, 3);
    const payloadPath = writePayload(
      {
        sessionId: "thread-backfill-dddd",
        cwd: CWD,
        codexHome,
        harnmemHome: home,
        reason: "backfill",
        rolloutName: name,
      },
      payloads,
    );
    const outcome = await runExtractPhase(payloadPath);
    assert.ok(!outcome.startsWith("failed"), `extraction should succeed, got: ${outcome}`);
    assert.ok(!existsSync(payloadPath), "payload must be consumed");

    const t = stamp(NOW);
    const journalPath = path.join(home, "sessions", `${t.y}${t.m}${t.d}`, "codex_thread-backfill-dddd.jsonl");
    assert.ok(existsSync(journalPath), `journal must exist at ${journalPath} (outcome: ${outcome})`);
    const journal = readFileSync(journalPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(journal.some((e) => e.role === "user" && String(e.text).includes("backfill probe")));

    assert.equal(readBackfillMarker(home), name, "marker must record the extracted rollout name");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(payloads, { recursive: true, force: true });
  }
});

test("memory_context queues backfill payloads for unextracted rollouts only", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-bf2-home-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-bf2-code-"));
  const payloads = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-bf2-pay-"));
  const liveThread = "thread-live-eeee";
  const extracted = seedRollout(codexHome, "thread-done-ffff", 1, 1);
  const pending = seedRollout(codexHome, "thread-open-gggg", 0, 2);
  try {
    // Pretend thread-done-ffff was already extracted: the marker covers it.
    mkdirSync(path.join(home, "state"), { recursive: true });
    writeFileSync(backfillMarkerPath(home), JSON.stringify({ lastFile: extracted, ts: NOW.toISOString() }), "utf8");

    const child = spawn(process.execPath, [mcpPath], {
      cwd: pkgRoot,
      env: { ...process.env, HARNMEM_HOME: home, CODEX_HOME: codexHome, HARNMEM_PAYLOAD_DIR: payloads },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.resume();
    let buffer = "";
    const pendingMsgs = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) pendingMsgs.push(JSON.parse(line));
      }
    });
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    const recv = (id) =>
      new Promise((res, rej) => {
        const start = Date.now();
        const poll = () => {
          const found = pendingMsgs.find((m) => m.id === id);
          if (found) return res(found);
          if (Date.now() - start > 30_000) return rej(new Error(`timeout id=${id}`));
          setTimeout(poll, 25);
        };
        poll();
      });
    const payloadFor = (threadId) =>
      existsSync(payloads)
        ? readdirSync(payloads).filter((n) => n.startsWith(`session-end-${threadId}`))
        : [];

    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await recv(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memory_context", arguments: { hook_event_name: "SessionStart", session_id: liveThread, cwd: CWD } },
      });
      await recv(2);

      // The detached worker consumes its payload quickly; poll for either the
      // file (queued) or its absence after consumption (done) — the marker is
      // the durable evidence either way.
      const deadline = Date.now() + 20_000;
      let marker = "";
      while (Date.now() < deadline) {
        marker = readBackfillMarker(home);
        if (marker === pending) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(marker, pending, "marker must advance to the pending rollout");

      // A second session start queues nothing new: the marker now covers it.
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memory_context", arguments: { hook_event_name: "SessionStart", session_id: liveThread, cwd: CWD } },
      });
      await recv(3);
      await new Promise((r) => setTimeout(r, 700));
      assert.equal(payloadFor("thread-open-gggg").length, 0, "no new payload once the marker covers the rollout");
      assert.equal(payloadFor("thread-done-ffff").length, 0, "already-extracted rollout must never re-queue");
    } finally {
      child.kill();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
    await rm(payloads, { recursive: true, force: true });
  }
});
