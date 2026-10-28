import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpPath = path.join(pkgRoot, "mcp", "mcp.mjs");

/**
 * Start a fresh server process and call memory_context once. The engine is
 * opened inside the child, so byte-stability across calls is measured across
 * full process lifecycles (the property the contract actually requires).
 */
function contextCall(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcpPath], {
      cwd: pkgRoot,
      env: { ...process.env, HARNMEM_HOME: env.HARNMEM_HOME, ...(env.extra || {}) },
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
    const timer = setTimeout(() => reject(new Error(`timeout; stderr=${stderr}`)), 20_000);
    const finish = (fn) => {
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const step = (id) =>
      new Promise((res, rej) => {
        const start = Date.now();
        const poll = () => {
          const found = pending.find((m) => m.id === id);
          if (found) return res(found);
          if (Date.now() - start > 20_000) return rej(new Error(`timeout id=${id}; stderr=${stderr}`));
          setTimeout(poll, 25);
        };
        poll();
      });

    (async () => {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await step(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "memory_context",
          arguments: {
            hook_event_name: "SessionStart",
            session_id: "019a2b3c-test",
            cwd: env.cwd || pkgRoot,
            ...args,
          },
        },
      });
      const resp = await step(2);
      finish(() => resolve(resp.result.content[0].text));
    })().catch((err) => finish(() => reject(err)));
  });
}

async function seedMemory(home, title, content) {
  const core = await import(pathToFileUrl(path.join(pkgRoot, "vendor", "core", "index.js")));
  const eng = await core.HarnMem.open({ home, harness: "codex", sessionId: "seed" });
  try {
    await eng.write({ type: "project", title, description: title, content });
  } finally {
    await eng.close().catch(() => {});
  }
}

function pathToFileUrl(p) {
  return "file:///" + p.replace(/\\/g, "/");
}

test("memory_context: empty store injects nothing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-inj-"));
  try {
    const text = await contextCall({ HARNMEM_HOME: home });
    assert.equal(text, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("memory_context: seeded snapshot, byte-stable across processes, capped at 10k bytes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-inj-"));
  try {
    await seedMemory(home, "包管理器统一用 pnpm", "用户要求本仓库一律 pnpm，不用 npm。");
    const a = await contextCall({ HARNMEM_HOME: home });
    const b = await contextCall({ HARNMEM_HOME: home });
    assert.equal(a, b, "two fresh processes must produce byte-identical injection");
    assert.ok(a.includes("包管理器统一用 pnpm"), "snapshot must contain the seeded title");
    assert.ok(a.includes("HarnMem memory (cross-harness; stable snapshot)"), "snapshot must carry the stable header");
    assert.ok(Buffer.byteLength(a, "utf8") <= 10_000, "injection must respect the 10k byte cap");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("memory_context: disabled or inject=off injects nothing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-cx-inj-"));
  try {
    await seedMemory(home, "seed-disabled", "body");
    const off = await contextCall({ HARNMEM_HOME: home, extra: { HARNMEM_DISABLED: "1" } });
    assert.equal(off, "");
    const noInject = await contextCall({ HARNMEM_HOME: home, extra: { HARNMEM_INJECT: "0" } });
    assert.equal(noInject, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
