import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpPath = path.join(pkgRoot, "mcp", "mcp.mjs");

const THREAD = "019a2b3c-anchor";

/**
 * Session anchoring is the adapter's provenance contract: only the hook
 * templates carry the real Codex thread id, and every later model tool call
 * (which has no session_id) must reuse it instead of opening an unanchored
 * engine. Pinned down end-to-end: the anchor arrives through memory_context,
 * a session-less memory_write lands with source.session === anchor, and the
 * anchoring cwd re-resolves settings so a project-level .harnmem.json
 * (inject:false) silences injection.
 */
test("hook call anchors the session; session-less writes inherit it; anchored cwd re-resolves project config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-anchor-"));
  const project = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-anchorp-"));
  await mkdirSync(path.join(project, "nested"), { recursive: true });
  await writeFileSync(path.join(project, ".harnmem.json"), JSON.stringify({ inject: false }), "utf8");
  const srv = startServer({ HARNMEM_HOME: home });
  try {
    // 1. SessionStart hook anchor against the project dir — injection must be
    //    off because the project config says so (proves the re-resolve).
    srv.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "memory_context",
        arguments: { hook_event_name: "SessionStart", session_id: THREAD, cwd: project },
      },
    });
    const ctxResp = await srv.recv(2);
    assert.equal(ctxResp.result.content[0].text, "", "project .harnmem.json inject:false must disable injection");

    // 2. A model tool call without session_id inherits the anchored session.
    srv.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_write",
        arguments: {
          type: "project",
          title: "anchoring probe",
          description: "anchoring probe",
          content: "written without a session_id to prove anchoring",
        },
      },
    });
    const write = await srv.recv(3);
    assert.equal(write.result.isError, undefined);
    const id = /^stored (mem_\w+) \(NEW\)$/.exec(write.result.content[0].text)?.[1];
    assert.ok(id, `write must store a new record, got: ${write.result.content[0].text}`);

    // 3. Provenance recorded under the anchored harness + thread id.
    const core = await import(pathToFileUrl(path.join(pkgRoot, "vendor", "core", "index.js")));
    const eng = await core.HarnMem.open({ home, harness: "verify", sessionId: "verify" });
    try {
      const found = await eng.read(id);
      assert.ok(found, "record must be readable");
      assert.equal(found.record?.source?.harness, "codex");
      assert.equal(found.record?.source?.session, THREAD);
    } finally {
      await eng.close().catch(() => {});
    }
  } finally {
    srv.child.kill();
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

function startServer(env) {
  const child = spawn(process.execPath, [mcpPath], {
    cwd: pkgRoot,
    env: { ...process.env, HARNMEM_HOME: env.HARNMEM_HOME },
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
  return {
    child,
    send: (msg) => child.stdin.write(JSON.stringify(msg) + "\n"),
    recv: (id, timeoutMs = 20_000) =>
      new Promise((res, rej) => {
        const start = Date.now();
        const poll = () => {
          const found = pending.find((m) => m.id === id);
          if (found) return res(found);
          if (Date.now() - start > timeoutMs) return rej(new Error(`timeout id=${id}; stderr=${stderr}`));
          setTimeout(poll, 25);
        };
        poll();
      }),
  };
}

function pathToFileUrl(p) {
  return "file:///" + p.replace(/\\/g, "/");
}
