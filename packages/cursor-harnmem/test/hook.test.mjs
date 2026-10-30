import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookPath = path.join(pkgRoot, "hooks", "hook.mjs");

/** Spawn the hook with one JSON payload on stdin. Never touches the real store. */
function runHook(payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      cwd: pkgRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function seedMemory(home, { title, content, type = "project" }) {
  const mod = await import(pathToFileURL(path.join(pkgRoot, "vendor", "core", "index.js")).href);
  const eng = await mod.HarnMem.open({ home, harness: "cursor", sessionId: "seed" });
  const result = await eng.write({ type, title, description: title, content });
  await eng.close();
  return result;
}

/** A temp "user Cursor dir" holding only our state, plus a temp store home. */
async function fixture(prefix) {
  const state = await mkdtemp(path.join(os.tmpdir(), `harnmem-cursor-${prefix}-state-`));
  const home = await mkdtemp(path.join(os.tmpdir(), `harnmem-cursor-${prefix}-home-`));
  const env = { HARNMEM_HOME: home, HARNMEM_CURSOR_STATE_DIR: state };
  return { state, home, env };
}

function submitPayload(overrides = {}) {
  return {
    hook_event_name: "beforeSubmitPrompt",
    prompt: "hello",
    attachments: [],
    composer_mode: "agent",
    conversation_id: "conv-1",
    generation_id: "gen-1",
    session_id: "sess-1",
    model: "cursor-grok-4.6-medium",
    model_id: "grok-4.6",
    transcript_path: null,
    ...overrides,
  };
}

test("first prompt on an empty store prints nothing (0-byte injection) but records the marker", async () => {
  const { state, home, env } = await fixture("empty");
  try {
    const r = await runHook(submitPayload(), { ...env, CURSOR_PROJECT_DIR: pkgRoot });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    const markers = async () => (await readdir(path.join(state, "injected"))).filter((f) => !f.startsWith("claim-"));
    assert.equal((await markers()).length, 1, "one conversation => one marker");
    // The second prompt of the same conversation must stay silent without
    // booting the engine again (same generation, claim already taken).
    const again = await runHook(submitPayload(), { ...env, CURSOR_PROJECT_DIR: pkgRoot });
    assert.equal(again.stdout, "");
    assert.equal((await markers()).length, 1);
    // Opening the engine seeds the store skeleton (scope directories and
    // index); no memory record was written and no session was journalled.
    const records = (await readdir(path.join(home, "memories"), { recursive: true }).catch(() => []))
      .map(String)
      .filter((name) => name.endsWith(".md"));
    assert.deepEqual(records, []);
    assert.deepEqual(await readdir(path.join(home, "sessions")).catch(() => []), []);
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("first prompt injects a stable snapshot once per conversation", async () => {
  const { state, home, env } = await fixture("inject");
  try {
    await seedMemory(home, { title: "Inject test decision", content: "Use node 22 everywhere. **Why:** engines field." });
    const first = await runHook(submitPayload({ conversation_id: "conv-a" }), { ...env, CURSOR_PROJECT_DIR: pkgRoot });
    assert.equal(first.code, 0);
    const parsed = JSON.parse(first.stdout);
    assert.deepEqual(Object.keys(parsed), ["additional_context"], "flat additional_context is the verified channel");
    assert.ok(parsed.additional_context.includes("Inject test decision"), "title must appear in the injection");
    assert.ok(parsed.additional_context.includes("HarnMem memory (cross-harness; stable snapshot)"), "core header present");
    assert.ok(Buffer.byteLength(parsed.additional_context, "utf8") <= 10_000, "must respect the injection cap");

    // The model answered, so the conversation is confirmed and later prompts
    // are silent, even though they carry a new generation id.
    const confirmed = await runHook(
      { hook_event_name: "afterAgentResponse", conversation_id: "conv-a", session_id: "sess-1", text: "ok" },
      { ...env, CURSOR_PROJECT_DIR: pkgRoot },
    );
    assert.equal(confirmed.code, 0);
    const repeat = await runHook(submitPayload({ conversation_id: "conv-a", generation_id: "gen-2" }), {
      ...env,
      CURSOR_PROJECT_DIR: pkgRoot,
    });
    assert.equal(repeat.stdout, "");

    // A new conversation with unchanged store state must be byte-identical.
    const second = await runHook(submitPayload({ conversation_id: "conv-b" }), { ...env, CURSOR_PROJECT_DIR: pkgRoot });
    assert.equal(second.stdout, first.stdout, "same store state must produce volatile-free identical injection");
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("a retry after a failed first turn re-injects instead of staying silent", async () => {
  const { state, home, env } = await fixture("retry");
  try {
    await seedMemory(home, { title: "Retry test decision", content: "The retry must see the snapshot too." });
    const first = await runHook(submitPayload({ conversation_id: "conv-retry", generation_id: "gen-failed" }), {
      ...env,
      CURSOR_PROJECT_DIR: pkgRoot,
    });
    assert.equal(first.code, 0);
    assert.ok(first.stdout.includes("Retry test decision"));
    // No afterAgentResponse happened: the model never ran (e.g. "model
    // unavailable"), so the marker stays pending and the retry re-injects.
    const retry = await runHook(submitPayload({ conversation_id: "conv-retry", generation_id: "gen-retry" }), {
      ...env,
      CURSOR_PROJECT_DIR: pkgRoot,
    });
    assert.equal(retry.stdout, first.stdout, "the retry must repeat the same stable snapshot");
    const marker = JSON.parse(
      await readFile(
        path.join(state, "injected", (await readdir(path.join(state, "injected"))).find((f) => !f.startsWith("claim-"))),
        "utf8",
      ),
    );
    assert.equal(marker.state, "pending");
    assert.equal(marker.attempts, 2);
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("non-agent composer modes and disabled stores inject nothing", async () => {
  const { state, home, env } = await fixture("skip");
  try {
    await seedMemory(home, { title: "Should not appear everywhere", content: "secret" });
    const ask = await runHook(submitPayload({ conversation_id: "conv-ask", composer_mode: "ask" }), {
      ...env,
      CURSOR_PROJECT_DIR: pkgRoot,
    });
    assert.equal(ask.stdout, "", "ask mode is not the agent composer");
    const off = await runHook(submitPayload({ conversation_id: "conv-off" }), {
      ...env,
      CURSOR_PROJECT_DIR: pkgRoot,
      HARNMEM_DISABLED: "1",
    });
    assert.equal(off.stdout, "", "HARNMEM_DISABLED must suppress injection");
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("sessionEnd journals a Cursor transcript synchronously when asked to", async () => {
  const { state, home, env } = await fixture("end");
  const work = await mkdtemp(path.join(os.tmpdir(), "harnmem-cursor-end-work-"));
  try {
    const transcript = [
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<timestamp>Friday, Oct 30, 2026, 4:22 PM (UTC+8)</timestamp>\n<user_query>\n我们决定统一用 pnpm，不再用 npm\n</user_query>",
            },
          ],
        },
      }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "明白，仓库统一 pnpm。" }] } }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
    ].join("\n");
    const transcriptPath = path.join(work, "conversation.jsonl");
    await writeFile(transcriptPath, transcript, "utf8");
    const r = await runHook(
      {
        hook_event_name: "sessionEnd",
        conversation_id: "conv-end",
        session_id: "sess-end",
        reason: "user_close",
        is_background_agent: false,
        transcript_path: transcriptPath,
      },
      { ...env, CURSOR_PROJECT_DIR: work, HARNMEM_EXTRACT_SYNC: "1" },
    );
    assert.equal(r.code, 0);
    const sessions = await readdir(path.join(home, "sessions")).catch(() => []);
    assert.ok(sessions.length >= 1, "session journal must exist");
    const leftover = (await readdir(state)).filter(
      (f) => f.startsWith("session-end-") && !f.startsWith("session-end-claim-"),
    );
    assert.equal(leftover.length, 0, "extract phase must consume its payload file");
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("sessionEnd skips background agents and missing transcripts without writing", async () => {
  const { state, home, env } = await fixture("end-skip");
  const work = await mkdtemp(path.join(os.tmpdir(), "harnmem-cursor-end-skip-work-"));
  try {
    const transcriptPath = path.join(work, "conversation.jsonl");
    await writeFile(transcriptPath, JSON.stringify({ role: "user", message: { content: "hello" } }), "utf8");
    const background = await runHook(
      {
        hook_event_name: "sessionEnd",
        conversation_id: "conv-bg",
        session_id: "sess-bg",
        reason: "user_close",
        is_background_agent: true,
        transcript_path: transcriptPath,
      },
      { ...env, CURSOR_PROJECT_DIR: work, HARNMEM_EXTRACT_SYNC: "1" },
    );
    assert.equal(background.code, 0);
    const noTranscript = await runHook(
      { hook_event_name: "sessionEnd", conversation_id: "conv-none", session_id: "sess-none", reason: "user_close" },
      { ...env, CURSOR_PROJECT_DIR: work, HARNMEM_EXTRACT_SYNC: "1" },
    );
    assert.equal(noTranscript.code, 0);
    const sessions = await readdir(path.join(home, "sessions")).catch(() => []);
    assert.equal(sessions.length, 0, "background agents and missing transcripts must not journal");
    assert.equal((await readdir(state)).filter((f) => f.startsWith("session-end-")).length, 0);
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("duplicate beforeSubmitPrompt invocations inject exactly once", async () => {
  const { state, home, env } = await fixture("dup-submit");
  try {
    await seedMemory(home, { title: "Duplicate guard", content: "Only one hook invocation may inject." });
    // Cursor runs the step from the user hooks file and (when it imports the
    // plugin) from the plugin manifest as well; both reach the same script.
    const [a, b] = await Promise.all([
      runHook(submitPayload({ conversation_id: "conv-dup" }), { ...env, CURSOR_PROJECT_DIR: pkgRoot }),
      runHook(submitPayload({ conversation_id: "conv-dup" }), { ...env, CURSOR_PROJECT_DIR: pkgRoot }),
    ]);
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    const injected = [a.stdout, b.stdout].filter((out) => out.trim().length > 0);
    assert.equal(injected.length, 1, "the exclusive claim must let exactly one invocation inject");
    const markers = (await readdir(path.join(state, "injected"))).filter((f) => !f.startsWith("claim-"));
    assert.equal(markers.length, 1);
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("duplicate sessionEnd invocations journal the conversation once", async () => {
  const { state, home, env } = await fixture("dup-end");
  const work = await mkdtemp(path.join(os.tmpdir(), "harnmem-cursor-dup-end-work-"));
  try {
    const transcript = [
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "<user_query>\njournal once\n</user_query>" }] } }),
      JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "journaled once" }] } }),
    ].join("\n");
    const transcriptPath = path.join(work, "conversation.jsonl");
    await writeFile(transcriptPath, transcript, "utf8");
    const payload = {
      hook_event_name: "sessionEnd",
      conversation_id: "conv-dup-end",
      session_id: "sess-dup-end",
      reason: "user_close",
      is_background_agent: false,
      transcript_path: transcriptPath,
    };
    const hookEnv = { ...env, CURSOR_PROJECT_DIR: work, HARNMEM_EXTRACT_SYNC: "1" };
    const [a, b] = await Promise.all([runHook(payload, hookEnv), runHook(payload, hookEnv)]);
    assert.equal(a.code, 0);
    assert.equal(b.code, 0);
    const journals = (await readdir(path.join(home, "sessions"), { recursive: true }).catch(() => []))
      .map(String)
      .filter((name) => name.endsWith(".jsonl"));
    assert.equal(journals.length, 1, "duplicate sessionEnd must not journal twice");
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
});

test("unknown event / malformed stdin exits 0 with empty stdout", async () => {
  const { state, home, env } = await fixture("bad");
  try {
    const unknown = await runHook({ hook_event_name: "SomethingElse" }, { ...env });
    assert.equal(unknown.stdout, "");
    assert.equal(unknown.code, 0);
    const child = spawn(process.execPath, [hookPath], {
      cwd: pkgRoot,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stdin.write("this is not json");
    child.stdin.end();
    const code = await new Promise((res) => child.on("close", res));
    assert.equal(out, "");
    assert.equal(code, 0);
    void home;
  } finally {
    await rm(state, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
