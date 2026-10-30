/**
 * End-to-end MCP server contract for the Grok adapter.
 *
 * Grok injects a plugin MCP server's `initialize.instructions` as a
 * `<system-reminder>` before the first model call — that is the only pre-turn
 * injection channel that survives Grok 1.0.70's observe-only SessionStart
 * (probe P10/P13/P19, docs/research/grok-plugin.md §1/§3.4). These tests pin:
 *  - empty store => no instructions field at all (0-byte rule);
 *  - seeded store => instructions carry the byte-stable snapshot;
 *  - the byte cap + memory_context fallback pointer;
 *  - six tools, the canonical read/write path, and protocol errors.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP = path.join(pkgRoot, "mcp", "mcp.mjs");

function startServer(env = {}) {
  const child = spawn(process.execPath, [MCP], {
    cwd: pkgRoot,
    env: { ...process.env, ...env },
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
      if (!line) continue;
      const waiter = pending.shift();
      if (waiter) waiter(JSON.parse(line));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const next = () =>
    new Promise((resolveNext, reject) => {
      const timer = setTimeout(() => reject(new Error(`server response timeout; stderr=${stderr}`)), 20_000);
      pending.push((msg) => {
        clearTimeout(timer);
        resolveNext(msg);
      });
    });
  const close = () =>
    new Promise((resolveClose) => {
      child.once("exit", () => resolveClose());
      child.kill();
    });
  return { send, next, close };
}

async function handshake(server) {
  server.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const response = await server.next();
  return response.result;
}

async function callTool(server, id, name, args = {}) {
  server.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const response = await server.next();
  return response.result;
}

async function seedMemory(home, title, description) {
  const server = startServer({ HARNMEM_HOME: home });
  try {
    await handshake(server);
    const result = await callTool(server, 2, "memory_write", {
      type: "feedback",
      title,
      description,
      content: `**Why:** ${description}\n\n**How to apply:** call this back when relevant.`,
    });
    assert.match(result.content[0].text, /^stored mem_/);
  } finally {
    await server.close();
  }
}

test("empty store omits instructions; handshake still succeeds", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "harnmem-grok-mcp-empty-"));
  const server = startServer({ HARNMEM_HOME: home });
  try {
    const result = await handshake(server);
    assert.equal(result.serverInfo.name, "harnmem");
    assert.equal(result.protocolVersion, "2024-11-05");
    assert.equal(Object.hasOwn(result, "instructions"), false, "empty store must inject zero bytes");
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("seeded store injects a byte-stable instructions snapshot", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "harnmem-grok-mcp-seed-"));
  try {
    await seedMemory(home, "Commit messages use Chinese prefixes", "用户偏好：提交信息用中文前缀。");
    const first = startServer({ HARNMEM_HOME: home });
    let instructionsA;
    try {
      instructionsA = (await handshake(first)).instructions;
    } finally {
      await first.close();
    }
    assert.equal(typeof instructionsA, "string");
    assert.match(instructionsA, /HarnMem memory/);
    assert.match(instructionsA, /Commit messages use Chinese prefixes/);
    assert.ok(Buffer.byteLength(instructionsA, "utf8") <= 2_500, "default instructions cap is 2,500 bytes");

    const second = startServer({ HARNMEM_HOME: home });
    try {
      const instructionsB = (await handshake(second)).instructions;
      assert.equal(instructionsB, instructionsA, "snapshot must be byte-stable across process restarts");
    } finally {
      await second.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("instructions respect HARNMEM_GROK_MAX_INSTRUCT_BYTES and point at memory_context", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "harnmem-grok-mcp-cap-"));
  try {
    // Distinct, semantically unrelated records: near-duplicates would supersede
    // each other, and the cap test cares about volume, not dedupe.
    await seedMemory(home, "Commit messages use Chinese prefixes", "用户偏好：提交信息用中文前缀。");
    await seedMemory(home, "Never force-push master", "直接推 master 是明确禁止的；改动一律走 worktree 加 PR。");
    await seedMemory(
      home,
      "Release checklist runs the full gate",
      "发版前按顺序执行 build、typecheck、test、eval:gate；任何一项红了都不发布。".repeat(4),
    );
    const server = startServer({ HARNMEM_HOME: home, HARNMEM_GROK_MAX_INSTRUCT_BYTES: "120" });
    try {
      const instructions = (await handshake(server)).instructions;
      assert.equal(typeof instructions, "string");
      assert.ok(Buffer.byteLength(instructions, "utf8") <= 120, `instructions exceeded cap: ${instructions.length}`);
      assert.match(instructions, /memory_context for the full snapshot/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("tools/list exposes the canonical five tools plus memory_context", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "harnmem-grok-mcp-tools-"));
  const server = startServer({ HARNMEM_HOME: home });
  try {
    await handshake(server);
    server.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = (await server.next()).result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "memory_context",
      "memory_forget",
      "memory_read",
      "memory_search",
      "memory_status",
      "memory_write",
    ]);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("write -> search -> context -> status round-trip", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "harnmem-grok-mcp-e2e-"));
  const server = startServer({ HARNMEM_HOME: home });
  try {
    await handshake(server);
    const write = await callTool(server, 2, "memory_write", {
      type: "feedback",
      title: "提交信息格式偏好",
      description: "用户偏好中文 conventional commit 前缀。",
      content: "**Why:** 团队文档统一中文。\n\n**How to apply:** git commit 用 feat:/fix: 中文描述。",
    });
    assert.match(write.content[0].text, /stored mem_\w+ \(NEW\)/);

    const search = await callTool(server, 3, "memory_search", { query: "提交信息 格式" });
    assert.match(search.content[0].text, /提交信息格式偏好/);

    const context = await callTool(server, 4, "memory_context", {});
    assert.match(context.content[0].text, /HarnMem memory/);
    assert.match(context.content[0].text, /提交信息格式偏好/);

    const status = await callTool(server, 5, "memory_status", {});
    assert.match(status.content[0].text, /harnmem v/);
    assert.match(status.content[0].text, new RegExp(`home=${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

    const unknown = await callTool(server, 6, "memory_does_not_exist", {});
    assert.equal(unknown.isError, true);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("disabled store injects nothing and refuses tools with a readable error", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "harnmem-grok-mcp-off-"));
  const server = startServer({ HARNMEM_HOME: home, HARNMEM_DISABLED: "1" });
  try {
    const result = await handshake(server);
    assert.equal(Object.hasOwn(result, "instructions"), false);
    const status = await callTool(server, 2, "memory_status", {});
    assert.equal(status.isError, true);
    assert.match(status.content[0].text, /disabled/i);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("unknown methods return -32601 and ping returns an empty result", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "harnmem-grok-mcp-proto-"));
  const server = startServer({ HARNMEM_HOME: home });
  try {
    await handshake(server);
    server.send({ jsonrpc: "2.0", id: 2, method: "ping", params: {} });
    assert.deepEqual((await server.next()).result, {});
    server.send({ jsonrpc: "2.0", id: 3, method: "not/a/method", params: {} });
    const response = await server.next();
    assert.equal(response.error.code, -32601);
  } finally {
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
