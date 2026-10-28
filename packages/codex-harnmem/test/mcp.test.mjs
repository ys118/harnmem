import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpPath = path.join(pkgRoot, "mcp", "mcp.mjs");

function startServer(env) {
  const child = spawn(process.execPath, [mcpPath], {
    cwd: pkgRoot,
    env: { ...process.env, HARNMEM_HOME: env.HARNMEM_HOME },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const pending = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      pending.push(JSON.parse(line));
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => (stderr += c));
  const rawChunks = [];
  child.stdout.on("data", (c) => rawChunks.push(String(c).slice(0, 120)));
  return {
    child,
    send: (msg) => child.stdin.write(JSON.stringify(msg) + "\n"),
    recv: async (id, timeoutMs = 20_000) => {
      const start = Date.now();
      for (;;) {
        const found = pending.find((m) => m.id === id);
        if (found) return found;
        if (Date.now() - start > timeoutMs)
          throw new Error(
            `timeout waiting for id=${id}; stderr=${stderr}; raw=${JSON.stringify(rawChunks)}; exitCode=${child.exitCode}; pid=${child.pid}`,
          );
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

test("MCP e2e: initialize, tools/list, Chinese write+search, status", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harnmem-cc-mcp-"));
  const srv = startServer({ HARNMEM_HOME: home });
  try {
    srv.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await srv.recv(1);
    assert.equal(init.result.serverInfo.name, "harnmem");
    assert.ok(init.result.protocolVersion);

    srv.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    srv.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = await srv.recv(2);
    const names = tools.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "memory_context",
      "memory_forget",
      "memory_read",
      "memory_search",
      "memory_session_end",
      "memory_status",
      "memory_write",
    ]);
    for (const tool of tools.result.tools) {
      const descBytes = Buffer.byteLength(tool.description || "", "utf8");
      assert.ok(descBytes > 0);
    }

    srv.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "memory_write",
        arguments: {
          type: "feedback",
          title: "提交信息使用英文并按 type(scope): 格式",
          description: "用户要求提交信息一律英文",
          content: "**Why:** 用户 2026-09 要求统一风格。\n**How to apply:** git commit -m \"feat(core): ...\"",
          tags: ["git"],
        },
      },
    });
    const write = await srv.recv(3);
    assert.equal(write.result.isError, undefined);
    const writeText = write.result.content[0].text;
    assert.match(writeText, /^stored mem_\w+ \(NEW\)$/);

    srv.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "memory_search", arguments: { query: "提交信息 格式" } } });
    const search = await srv.recv(4);
    const searchText = search.result.content[0].text;
    assert.ok(searchText.includes("提交信息使用英文"), "Chinese bigram search must hit the stored record");

    srv.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "memory_search", arguments: { query: "完全不存在的量子 phrase" } } });
    const miss = await srv.recv(5);
    assert.ok(miss.result.content[0].text.length > 0);

    srv.send({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "memory_status", arguments: {} } });
    const status = await srv.recv(6);
    assert.ok(status.result.content[0].text.includes(`home=${path.resolve(home)}`));

    srv.send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope", arguments: {} } });
    const bad = await srv.recv(7);
    assert.equal(bad.result.isError, true);

    srv.send({ jsonrpc: "2.0", id: 8, method: "bogus/method" });
    const nf = await srv.recv(8);
    assert.equal(nf.error.code, -32601);

    srv.send({ jsonrpc: "2.0", id: 9, method: "ping" });
    const pong = await srv.recv(9);
    assert.deepEqual(pong.result, {});
  } finally {
    srv.child.kill();
    await rm(home, { recursive: true, force: true });
  }
});
