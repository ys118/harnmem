import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpPath = path.join(pkgRoot, "mcp", "mcp.mjs");

const THREAD = "019a2b3c-extract";
const CWD = process.cwd();

function rolloutLine(type, payload, timestamp) {
  return JSON.stringify({ timestamp, type, payload });
}

function userMsg(text) {
  return rolloutLine("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] }, "2026-10-28T03:00:00.000Z");
}

/**
 * Full session-end chain in sync mode: hook tool -> payload -> inline
 * runExtractPhase -> rollout parse -> eng.sessionEnd journal. With the default
 * autoExtract=false the extraction itself records the audited
 * `auto_extract_off` skip — the journal is what this test pins down.
 */
test("memory_session_end (sync): journals the rollout and consumes the payload", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-end-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-codehome-"));
  try {
    // The worker's findRolloutFile scans today/yesterday with the REAL clock,
    // so the fixture must derive its date dirs and filename from now too —
    // hardcoding a date would make this test silently expire.
    const now = new Date();
    const stamp = (d) => ({
      y: String(d.getFullYear()),
      m: String(d.getMonth() + 1).padStart(2, "0"),
      d: String(d.getDate()).padStart(2, "0"),
    });
    const t = stamp(now);
    const dayDir = path.join(codexHome, "sessions", t.y, t.m, t.d);
    mkdirSync(dayDir, { recursive: true });
    const fileStamp = `${t.y}-${t.m}-${t.d}T10-59-00`;
    const rollout = [
      rolloutLine("session_meta", { id: THREAD }, "2026-10-28T02:59:00.000Z"),
      userMsg("<environment_context>\n  cwd: somewhere\n</environment_context>"),
      userMsg("以后这个仓库的发布流程：AI 生成命令，我在自己终端手动执行"),
      rolloutLine(
        "response_item",
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "已记录该约定，后续按此执行。" }] },
        "2026-10-28T03:01:00.000Z",
      ),
    ].join("\n");
    writeFileSync(path.join(dayDir, `rollout-${fileStamp}-${THREAD}.jsonl`), rollout, "utf8");

    const child = spawn(process.execPath, [mcpPath], {
      cwd: pkgRoot,
      env: {
        ...process.env,
        HARNMEM_HOME: home,
        HARNMEM_EXTRACT_SYNC: "1",
        CODEX_HOME: codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    const pending = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) pending.push(JSON.parse(line));
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));
    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
    const recv = (id) =>
      new Promise((res, rej) => {
        const start = Date.now();
        const poll = () => {
          const found = pending.find((m) => m.id === id);
          if (found) return res(found);
          if (Date.now() - start > 30_000) return rej(new Error(`timeout id=${id}; stderr=${stderr}`));
          setTimeout(poll, 25);
        };
        poll();
      });

    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await recv(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      // SessionStart first (anchors the session id inside the server).
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memory_context", arguments: { hook_event_name: "SessionStart", session_id: THREAD, cwd: CWD } },
      });
      await recv(2);
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "memory_session_end", arguments: { hook_event_name: "SessionEnd", session_id: THREAD, cwd: CWD } },
      });
      const end = await recv(3);
      const text = end.result.content[0].text;
      assert.ok(text.includes("sync"), `outcome should be the sync line, got: ${text}`);

      // The payload file was consumed.
      const payloadDir = path.join(os.tmpdir(), "harnmem-codex");
      const leftover = existsSync(payloadDir)
        ? readdirSync(payloadDir).filter((n) => n.startsWith(`session-end-${THREAD}`))
        : [];
      assert.equal(leftover.length, 0, "payload must be consumed after sync extraction");

      // The session journal recorded the user prompt:
      // sessions/<YYYYMMDD>/codex_<threadId>.jsonl with {ts, role, text}.
      const dayStamp = `${t.y}${t.m}${t.d}`;
      const journalPath = path.join(home, "sessions", dayStamp, `codex_${THREAD}.jsonl`);
      assert.ok(existsSync(journalPath), `session journal must exist at ${journalPath}`);
      const journal = readFileSync(journalPath, "utf8")
        .replace(/^\uFEFF/, "")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const userEntries = journal.filter((e) => e.role === "user");
      assert.ok(
        userEntries.some((e) => String(e.text || "").includes("AI 生成命令")),
        "journal must keep the user prompt",
      );
      const boilerplate = userEntries.filter((e) => String(e.text || "").startsWith("<environment_context>"));
      assert.equal(boilerplate.length, 0, "harness boilerplate must not reach the journal");
    } finally {
      child.kill();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(codexHome, { recursive: true, force: true });
  }
});
