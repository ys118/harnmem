import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { createLlm, createLlmFromEnv } from "../lib/llm.mjs";

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

function stopServer(server) {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  server.close();
}

test("createLlm requires both url and model", () => {
  assert.equal(createLlm({}), null);
  assert.equal(createLlm({ url: "https://example.test/v1" }), null);
  assert.equal(createLlm({ model: "m" }), null);
  assert.equal(typeof createLlm({ url: "https://example.test/v1", model: "m" }), "function");
});

test("createLlmFromEnv reads the documented variables", () => {
  assert.equal(createLlmFromEnv({}), null);
  assert.equal(typeof createLlmFromEnv({ HARNMEM_LLM_URL: "http://127.0.0.1:1/v1", HARNMEM_LLM_MODEL: "m" }), "function");
});

test("LLM calls normalise the endpoint and parse usage", async (t) => {
  let seen = null;
  const { server, base } = await startServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: "hello" } }],
          usage: { prompt_tokens: 7, completion_tokens: 3 },
        }),
      );
    });
  });
  t.after(() => stopServer(server));

  const llm = createLlm({ url: `${base}/v1/`, model: "test-model", apiKey: "secret", timeoutMs: 5000 });
  const result = await llm({ system: "sys", prompt: "user" });
  assert.equal(result.text, "hello");
  assert.equal(result.promptTokens, 7);
  assert.equal(result.completionTokens, 3);
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(seen.auth, "Bearer secret");
  assert.equal(seen.body.model, "test-model");
  assert.deepEqual(seen.body.messages, [
    { role: "system", content: "sys" },
    { role: "user", content: "user" },
  ]);
  assert.equal(seen.body.stream, false);
});

test("LLM calls accept an endpoint that already names the route", async (t) => {
  let seenUrl = "";
  const { server, base } = await startServer((req, res) => {
    seenUrl = req.url;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  t.after(() => stopServer(server));

  const llm = createLlm({ url: `${base}/v1/chat/completions`, model: "m", timeoutMs: 5000 });
  assert.equal((await llm({ system: "s", prompt: "p" })).text, "ok");
  assert.equal(seenUrl, "/v1/chat/completions");
});

test("LLM HTTP errors and empty completions are surfaced", async (t) => {
  const { server, base } = await startServer((req, res) => {
    if (req.url.includes("fail")) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("boom");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "   " } }] }));
  });
  t.after(() => stopServer(server));

  const failing = createLlm({ url: `${base}/fail`, model: "m", timeoutMs: 5000 });
  await assert.rejects(() => failing({ system: "s", prompt: "p" }), /HTTP 500/);

  const empty = createLlm({ url: base, model: "m", timeoutMs: 5000 });
  await assert.rejects(() => empty({ system: "s", prompt: "p" }), /empty completion/);
});

test("LLM calls time out instead of hanging the session-end pass", async (t) => {
  const { server, base } = await startServer(() => {
    /* never responds */
  });
  t.after(() => stopServer(server));

  const llm = createLlm({ url: base, model: "m", timeoutMs: 100 });
  await assert.rejects(() => llm({ system: "s", prompt: "p" }), /timed out|aborted/i);
});
