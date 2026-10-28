import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findRolloutFile, parseCodexTranscript } from "../lib/rollout.mjs";

const THREAD = "019a2b3c-demo";

function line(entry) {
  return JSON.stringify(entry);
}

function msg(role, text, extraType) {
  return {
    timestamp: "2026-10-28T03:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
    ...(extraType || {}),
  };
}

test("parseCodexTranscript: keeps user+assistant, drops boilerplate/developer/malformed", () => {
  const raw = [
    line({ timestamp: "2026-10-28T02:59:59.000Z", type: "session_meta", payload: { id: THREAD } }),
    line(msg("user", "<environment_context>\n  cwd: D:\\x\n</environment_context>")),
    line(msg("developer", "you are a coding agent")),
    line(msg("user", "帮我把 README 的安装段落改成本仓库实际命令")),
    line("{ this is not json"),
    line(msg("assistant", "已改为：`pnpm install`（见 README §Install）。")),
    line({ timestamp: "2026-10-28T03:01:00.000Z", type: "event_msg", payload: { type: "token_count" } }),
  ].join("\n");
  const messages = parseCodexTranscript(raw);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "user");
  assert.ok(messages[0].text.startsWith("帮我把"));
  assert.equal(messages[1].role, "assistant");
  assert.ok(messages[1].text.includes("pnpm install"));
  assert.equal(messages[0].ts, Date.parse("2026-10-28T03:00:00.000Z"));
});

test("parseCodexTranscript: clips each message to 4000 chars and keeps the last 400", () => {
  const long = "x".repeat(5000);
  const lines = [];
  for (let i = 0; i < 450; i++) lines.push(line(msg("user", `turn ${i} ${long}`)));
  const messages = parseCodexTranscript(lines.join("\n"));
  assert.equal(messages.length, 400);
  assert.ok(messages[0].text.startsWith("turn 50 "), "oldest retained message is index 50");
  for (const m of messages) assert.ok(m.text.length <= 4000);
});

test("parseCodexTranscript: empty and garbage input yield empty arrays", () => {
  assert.deepEqual(parseCodexTranscript(""), []);
  assert.deepEqual(parseCodexTranscript("null\n{}\n[]"), []);
  assert.deepEqual(parseCodexTranscript(null), []);
  assert.deepEqual(parseCodexTranscript(undefined), []);
});

test("findRolloutFile: matches the thread id in today/yesterday dirs, newest wins", () => {
  const home = mkdtempSyncUnder(os.tmpdir(), "harnmem-cx-roll-");
  try {
    const { yesterday, today } = twoLocalDates();
    for (const d of [yesterday, today]) {
      const dir = path.join(home, "sessions", d.y, d.m, d.d);
      mkdirSync(dir, { recursive: true });
    }
    const yDir = path.join(home, "sessions", yesterday.y, yesterday.m, yesterday.d);
    const tDir = path.join(home, "sessions", today.y, today.m, today.d);
    writeFileSync(path.join(yDir, `rollout-2026-10-27T20-00-00-${THREAD}.jsonl`), "{}\n");
    writeFileSync(path.join(tDir, `rollout-2026-10-28T09-30-00-${THREAD}.jsonl`), "{}\n");
    writeFileSync(path.join(tDir, `rollout-2026-10-28T10-00-00-other.jsonl`), "{}\n");
    const found = findRolloutFile(home, THREAD, new Date(2026, 9, 28, 12, 0, 0));
    assert.ok(found, "rollout must be found");
    assert.ok(found.includes("2026-10-28T09-30-00"), "newest match wins");

    assert.equal(findRolloutFile(home, "does-not-exist", new Date(2026, 9, 28, 12, 0, 0)), undefined);
    assert.equal(findRolloutFile(home, "../escape", new Date()), undefined, "path traversal is sanitized away");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function mkdtempSyncUnder(parent, prefix) {
  const dir = path.join(parent, `${prefix}${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function twoLocalDates(now = new Date()) {
  const fmt = (d) => ({
    y: String(d.getFullYear()),
    m: String(d.getMonth() + 1).padStart(2, "0"),
    d: String(d.getDate()).padStart(2, "0"),
  });
  return { today: fmt(now), yesterday: fmt(new Date(now.getTime() - 86_400_000)) };
}
