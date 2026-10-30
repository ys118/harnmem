/**
 * Grok hook contract: SessionEnd only.
 *
 * Grok 1.0.70 renders the system prompt before SessionStart hooks run and
 * drops SessionStart additionalContext (probe P10/P13), so this adapter must
 * NOT register or handle SessionStart. These tests pin the SessionEnd path:
 * payload -> detached/inline extraction -> journaled transcript.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(pkgRoot, "hooks", "hook.mjs");
const PAYLOAD_DIR = path.join(tmpdir(), "harnmem-grok");

function runHookRaw(stdin, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: pkgRoot,
      env: { ...process.env, HARNMEM_EXTRACT_SYNC: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

function runHook(payload, env = {}) {
  return runHookRaw(JSON.stringify(payload), env);
}

async function walkFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else out.push(full);
  }
  return out;
}

/** Build a Grok session directory: <GROK_HOME>/sessions/<group>/<sessionId>/chat_history.jsonl. */
async function makeSession(grokHome, sessionId, { withChatHistory = true } = {}) {
  const dir = path.join(grokHome, "sessions", "D%3A%5Cfixture", sessionId);
  await mkdir(dir, { recursive: true });
  if (withChatHistory) {
    const lines = [
      { type: "system", content: "You are Grok." },
      { type: "user", content: [{ type: "text", text: "<rules>workspace rules</rules>" }] },
      { type: "user", content: [{ type: "text", text: "<user_query>明天提交信息用中文</user_query>" }], prompt_index: 0 },
      { type: "user", content: [{ type: "text", text: "<system-reminder>MCP servers connected</system-reminder>" }], synthetic_reason: "mcp_servers" },
      { type: "assistant", content: "好的，记下了。", model_id: "grok-test" },
    ];
    await writeFile(path.join(dir, "chat_history.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
    await writeFile(
      path.join(dir, "updates.jsonl"),
      `${JSON.stringify({ timestamp: 1, method: "session/update", params: { sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "明天提交信息用中文" } } } })}\n`,
      "utf8",
    );
  }
  return dir;
}

test("SessionEnd journals the main session transcript and consumes the payload", async () => {
  const grokHome = await mkdtemp(path.join(tmpdir(), "harnmem-grok-hook-grok-"));
  const harnmemHome = await mkdtemp(path.join(tmpdir(), "harnmem-grok-hook-home-"));
  const sessionId = "01a18c00-1111-7000-8000-000000000001";
  try {
    const sessionDir = await makeSession(grokHome, sessionId);
    const result = await runHook(
      {
        hookEventName: "session_end",
        hook_event_name: "SessionEnd",
        sessionId,
        session_id: sessionId,
        cwd: path.join(grokHome, "ws"),
        reason: "end_turn",
        transcriptPath: path.join(sessionDir, "updates.jsonl"),
      },
      { GROK_HOME: grokHome, HARNMEM_HOME: harnmemHome, HARNMEM_DEBUG: "1" },
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "", "hook stdout must stay empty");
    const files = await walkFiles(harnmemHome);
    const journal = files.filter((file) => file.includes(`${path.sep}sessions${path.sep}`));
    assert.ok(journal.length > 0, `no session journal written; files=${files.join(",")}`);
    const text = (await Promise.all(journal.map((file) => readFile(file, "utf8")))).join("\n");
    assert.match(text, /明天提交信息用中文/);
    assert.match(text, /好的，记下了/);

    const leftovers = (await readdir(PAYLOAD_DIR).catch(() => [])).filter((name) => name.includes(sessionId));
    assert.deepEqual(leftovers, [], "extract phase must remove its payload file");
  } finally {
    await rm(grokHome, { recursive: true, force: true });
    await rm(harnmemHome, { recursive: true, force: true });
  }
});

test("SessionEnd derives the session directory from GROK_HOME when transcriptPath is absent", async () => {
  const grokHome = await mkdtemp(path.join(tmpdir(), "harnmem-grok-hook-derive-"));
  const harnmemHome = await mkdtemp(path.join(tmpdir(), "harnmem-grok-hook-derive-home-"));
  const sessionId = "01a18c00-2222-7000-8000-000000000002";
  try {
    await makeSession(grokHome, sessionId);
    const result = await runHook(
      {
        hookEventName: "session_end",
        hook_event_name: "SessionEnd",
        sessionId,
        cwd: path.join(grokHome, "ws"),
      },
      { GROK_HOME: grokHome, HARNMEM_HOME: harnmemHome },
    );
    assert.equal(result.code, 0);
    const files = await walkFiles(harnmemHome);
    const text = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
    assert.match(text, /明天提交信息用中文/);
  } finally {
    await rm(grokHome, { recursive: true, force: true });
    await rm(harnmemHome, { recursive: true, force: true });
  }
});

test("subagent sessions never write or journal", async () => {
  const grokHome = await mkdtemp(path.join(tmpdir(), "harnmem-grok-hook-sub-"));
  const harnmemHome = await mkdtemp(path.join(tmpdir(), "harnmem-grok-hook-sub-home-"));
  const sessionId = "01a18c00-3333-7000-8000-000000000003";
  try {
    const sessionDir = await makeSession(grokHome, sessionId);
    const result = await runHook(
      {
        hookEventName: "session_end",
        hook_event_name: "SessionEnd",
        sessionId,
        cwd: path.join(grokHome, "ws"),
        subagentType: "explore",
        transcriptPath: path.join(sessionDir, "updates.jsonl"),
      },
      { GROK_HOME: grokHome, HARNMEM_HOME: harnmemHome },
    );
    assert.equal(result.code, 0);
    const files = await walkFiles(path.join(harnmemHome, "sessions"));
    assert.deepEqual(files, [], "subagent sessions must stay read-only");
  } finally {
    await rm(grokHome, { recursive: true, force: true });
    await rm(harnmemHome, { recursive: true, force: true });
  }
});

test("SessionStart payloads are silent no-ops (injection is MCP-only)", async () => {
  const grokHome = await mkdtemp(path.join(tmpdir(), "harnmem-grok-hook-start-"));
  const harnmemHome = await mkdtemp(path.join(tmpdir(), "harnmem-grok-hook-start-home-"));
  try {
    const result = await runHook(
      {
        hookEventName: "session_start",
        hook_event_name: "SessionStart",
        sessionId: "01a18c00-4444-7000-8000-000000000004",
        cwd: path.join(grokHome, "ws"),
        source: "new",
      },
      { GROK_HOME: grokHome, HARNMEM_HOME: harnmemHome },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    const files = await walkFiles(harnmemHome);
    assert.deepEqual(files, []);
  } finally {
    await rm(grokHome, { recursive: true, force: true });
    await rm(harnmemHome, { recursive: true, force: true });
  }
});

test("malformed stdin and missing session data never fail the session", async () => {
  const grokHome = await mkdtemp(path.join(tmpdir(), "harnmem-grok-hook-bad-"));
  const harnmemHome = await mkdtemp(path.join(tmpdir(), "harnmem-grok-hook-bad-home-"));
  try {
    const malformed = await runHookRaw("this is not json", { GROK_HOME: grokHome, HARNMEM_HOME: harnmemHome });
    assert.equal(malformed.code, 0);
    assert.equal(malformed.stdout, "");

    const missing = await runHook(
      { hookEventName: "session_end", sessionId: "01a18c00-5555-7000-8000-000000000005", cwd: path.join(grokHome, "ws") },
      { GROK_HOME: grokHome, HARNMEM_HOME: harnmemHome },
    );
    assert.equal(missing.code, 0);
    assert.equal(missing.stdout, "");
    // Store init creates the directory tree, but with no recoverable transcript
    // there must be no session journal and no crash.
    const journal = await walkFiles(path.join(harnmemHome, "sessions"));
    assert.deepEqual(journal, [], "no transcript => no journal, and no crash");
  } finally {
    await rm(grokHome, { recursive: true, force: true });
    await rm(harnmemHome, { recursive: true, force: true });
  }
});
