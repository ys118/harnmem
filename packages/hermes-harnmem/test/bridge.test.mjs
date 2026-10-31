import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { capText } from "../lib/bridge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePath = path.join(here, "..", "lib", "bridge.mjs");

/**
 * Run the bridge exactly the way the Hermes provider does: one process, one
 * JSON payload on stdin, exactly one JSON line on stdout.
 */
function run(payload, env = {}) {
  const result = spawnSync(process.execPath, [bridgePath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, ...env },
  });
  assert.equal(result.error, undefined, `bridge failed to run: ${result.error}`);
  const lines = (result.stdout || "").split("\n").filter((line) => line.trim() !== "");
  assert.equal(lines.length, 1, `expected one stdout line, got: ${JSON.stringify(result.stdout)}`);
  return JSON.parse(lines[0]);
}

/**
 * Async variant of {@link run}: the extraction test serves the fake LLM from an
 * in-process HTTP server, so the bridge must not block this process's event
 * loop while it waits for the response.
 */
function runAsync(payload, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const lines = stdout.split("\n").filter((line) => line.trim() !== "");
        if (lines.length !== 1) {
          reject(
            new Error(
              `expected one stdout line (exit ${code}); stdout: ${JSON.stringify(stdout)}; stderr: ${stderr}`,
            ),
          );
          return;
        }
        resolve(JSON.parse(lines[0]));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function withStore(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harnmem-hermes-bridge-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function basePayload(store, extra = {}) {
  return { cwd: store, home: store, sessionId: "test-session", ...extra };
}

test("ping reports the engine API version and node runtime", () => {
  const result = run({ command: "ping" });
  assert.equal(result.ok, true);
  assert.equal(result.apiVersion, 1);
  assert.match(String(result.node), /^v\d+\./);
});

test("empty store injects zero bytes and no ids", async () => {
  await withStore(async (store) => {
    const result = run(basePayload(store, { command: "context" }));
    assert.equal(result.ok, true);
    assert.equal(result.text, "");
    assert.equal(result.bytes, 0);
    assert.deepEqual(result.ids, []);
  });
});

test("write, search, read, forget and restore round trip", async () => {
  await withStore(async (store) => {
    const write = run(
      basePayload(store, {
        command: "write",
        input: {
          type: "user",
          title: "Prefers pnpm",
          description: "Uses pnpm over npm",
          content: "The user prefers pnpm over npm in this workspace.",
          tags: ["tooling"],
        },
      }),
    );
    assert.equal(write.ok, true);
    assert.equal(write.action, "NEW");
    assert.match(write.id, /^mem_/);

    const search = run(basePayload(store, { command: "search", query: "pnpm" }));
    assert.equal(search.ok, true);
    assert.ok(search.total >= 1);
    assert.equal(search.results[0].id, write.id);

    const read = run(basePayload(store, { command: "read", id: write.id }));
    assert.equal(read.ok, true);
    assert.equal(read.record.title, "Prefers pnpm");
    assert.equal(read.record.scope, "user");

    const context = run(basePayload(store, { command: "context" }));
    assert.equal(context.ok, true);
    assert.match(context.text, /HarnMem memory/);
    assert.match(context.text, /Prefers pnpm/);
    assert.ok(context.ids.includes(write.id));

    const forgotten = run(basePayload(store, { command: "forget", id: write.id }));
    assert.equal(forgotten.ok, true);
    assert.equal(forgotten.mode, "trash");

    const afterForget = run(basePayload(store, { command: "search", query: "pnpm" }));
    assert.equal(afterForget.ok, true);
    assert.equal(afterForget.total, 0);

    const restored = run(basePayload(store, { command: "restore", id: write.id }));
    assert.equal(restored.ok, true);

    const afterRestore = run(basePayload(store, { command: "search", query: "pnpm" }));
    assert.equal(afterRestore.ok, true);
    assert.equal(afterRestore.total, 1);
  });
});

test("Chinese queries hit bigram-indexed memories", async () => {
  await withStore(async (store) => {
    const write = run(
      basePayload(store, {
        command: "write",
        input: {
          type: "user",
          title: "偏好中文回答",
          description: "希望用中文与我们交流",
          content: "用户希望所有回答都使用中文。",
          tags: ["language"],
        },
      }),
    );
    assert.equal(write.ok, true);

    const search = run(basePayload(store, { command: "search", query: "中文回答" }));
    assert.equal(search.ok, true);
    assert.ok(search.total >= 1);
    assert.equal(search.results[0].id, write.id);

    const context = run(basePayload(store, { command: "context" }));
    assert.match(context.text, /中文/);
  });
});

test("context snapshots are byte-stable across processes", async () => {
  await withStore(async (store) => {
    const write = run(
      basePayload(store, {
        command: "write",
        input: { type: "project", title: "Uses pnpm workspace", description: "Monorepo layout", content: "pnpm workspace with packages/*" },
      }),
    );
    assert.equal(write.ok, true);
    const first = run(basePayload(store, { command: "context" }));
    const second = run(basePayload(store, { command: "context" }));
    assert.equal(first.text, second.text);
    assert.equal(first.bytes, second.bytes);
  });
});

test("status reports the store home and shard counts", async () => {
  await withStore(async (store) => {
    run(
      basePayload(store, {
        command: "write",
        input: { type: "user", title: "Likes short answers", description: "Prefers terse replies", content: "Prefers terse replies." },
      }),
    );
    const status = run(basePayload(store, { command: "status" }));
    assert.equal(status.ok, true);
    assert.equal(status.home, store);
    const userShard = (status.shards || []).find((shard) => shard.name === "user");
    assert.ok(userShard, "expected a user shard");
    assert.equal(userShard.total, 1);
  });
});

test("session-end without auto-extract reports the engine skip reason", async () => {
  await withStore(async (store) => {
    const result = run(
      basePayload(store, {
        command: "session-end",
        autoExtract: false,
        messages: [{ role: "user", text: "hello" }],
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, "skipped");
    assert.equal(result.skipReason, "auto_extract_off");
  });
});

test("session-end without an LLM reports no_llm after the message gates pass", async () => {
  await withStore(async (store) => {
    const filler = "x".repeat(240);
    const result = run(
      basePayload(store, {
        command: "session-end",
        autoExtract: true,
        messages: [
          { role: "user", text: `one ${filler}` },
          { role: "assistant", text: `ack ${filler}` },
          { role: "user", text: `two ${filler}` },
          { role: "user", text: `three ${filler}` },
        ],
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(result.status, "no_llm");
  });
});

test("session-end extracts memories through an OpenAI-compatible endpoint", async () => {
  const requests = [];
  const extraction = {
    memories: [
      {
        type: "project",
        category: "convention",
        scope: "project",
        title: "Uses pnpm for the monorepo",
        description: "Builds every package with pnpm, never npm.",
        content:
          "The monorepo build pipeline uses pnpm exclusively.\n\n**Why:** workspace links must stay honest.\n\n**How to apply:** run pnpm commands, not npm.",
        tags: ["tooling"],
        entities: ["pnpm"],
        importance: 6,
        confidence: 0.9,
        links: [],
        supersedes: [],
        evidence: ["user@turn-1"],
      },
    ],
  };
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ headers: request.headers, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(extraction) } }],
          usage: { prompt_tokens: 10, completion_tokens: 20 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await withStore(async (store) => {
      const filler = "y".repeat(240);
      const result = await runAsync(
        basePayload(store, {
          command: "session-end",
          autoExtract: true,
          messages: [
            { role: "user", text: `one ${filler}` },
            { role: "assistant", text: `ack ${filler}` },
            { role: "user", text: `two ${filler}` },
            { role: "user", text: `three ${filler}` },
          ],
          // The Python side strips the credential before writing the payload and
          // passes it in the child environment instead; assert both halves.
          llm: { url: `http://127.0.0.1:${port}/v1`, model: "test-model" },
        }),
        {
          HARNMEM_LLM_API_KEY: "test-key",
        },
      );
      assert.equal(result.ok, true);
      assert.equal(result.status, "done", `unexpected extraction result: ${JSON.stringify(result)}`);
      assert.ok(result.added.length >= 1, `expected extracted memories: ${JSON.stringify(result)}`);

      const search = run(basePayload(store, { command: "search", query: "pnpm monorepo" }));
      assert.equal(search.ok, true);
      assert.ok(search.total >= 1, "extracted memory should be searchable");
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(requests.length, 1, "expected exactly one LLM call");
  assert.equal(requests[0].headers.authorization, "Bearer test-key");
  assert.equal(requests[0].body.model, "test-model");
  assert.equal(requests[0].body.stream, false);
});

test("invalid payloads and unknown commands fail with structured codes", () => {
  const badJson = spawnSync(process.execPath, [bridgePath], { input: "{not json", encoding: "utf8" });
  assert.equal(badJson.status, 2);
  assert.equal(JSON.parse(badJson.stdout).code, "BAD_PAYLOAD");

  const unknown = run({ command: "nope" });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "UNKNOWN_COMMAND");

  const missingQuery = run({ command: "search", cwd: os.tmpdir(), home: os.tmpdir() });
  assert.equal(missingQuery.ok, false);
  assert.equal(missingQuery.code, "USAGE");
});

test("capText truncates on line boundaries and keeps the budget", () => {
  const text = ["a".repeat(80), "b".repeat(80), "c".repeat(80)].join("\n");
  const capped = capText(text, 120);
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.length <= 120);
  assert.match(capped.text, /context truncated/);

  const untouched = capText("short", 120);
  assert.equal(untouched.truncated, false);
  assert.equal(untouched.text, "short");
});

test("the bridge dispatches when invoked through a linked plugin directory", async (t) => {
  // The documented local-dev install links the package into the Hermes plugin
  // directory. argv[1] is then the link path while Node resolves the module
  // through its target; the entry-point guard must still fire.
  const scratch = await mkdtemp(path.join(os.tmpdir(), "harnmem-link-"));
  const link = path.join(scratch, "harnmem");
  try {
    try {
      await symlink(path.join(here, ".."), link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`directory links are unavailable here: ${error.message}`);
      return;
    }
    const result = spawnSync(process.execPath, [path.join(link, "lib", "bridge.mjs")], {
      input: JSON.stringify({ command: "ping" }),
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `bridge through a link failed: ${result.stderr}`);
    const lines = (result.stdout || "").split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 1, `expected one stdout line, got: ${JSON.stringify(result.stdout)}`);
    assert.equal(JSON.parse(lines[0]).ok, true);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
