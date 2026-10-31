#!/usr/bin/env node
/**
 * JSON-to-JSON bridge between the Hermes Python memory provider and the vendored
 * @harnmem/core engine. One process handles exactly one command, so a crash or a
 * slow engine call can never poison a long-lived Hermes session.
 *
 * Contract (invoked by bridge.py):
 *   - payload: one JSON object, read from ``--payload <file>`` when given,
 *     otherwise from stdin;
 *   - stdout: exactly ONE JSON line — ``{"ok":true,...}`` or
 *     ``{"ok":false,"error":"..."}``. Nothing else may be written there: Hermes
 *     treats provider stdout as data;
 *   - stderr: adapter/engine diagnostics only;
 *   - exit code: 0 whenever a JSON answer was produced (including ``ok:false``),
 *     1 on an unexpected crash, 2 on a usage error.
 *
 * A ``--payload <file>`` invocation is deleted once handled: the Hermes side
 * writes session-end payloads to a temp file and detaches this process, so the
 * bridge owns the cleanup.
 */

import { realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createLlm, createLlmFromEnv } from "./llm.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendorEntry = path.join(here, "..", "vendor", "core", "index.js");

const DEFAULT_MAX_CHARS = 10_000;
const DEFAULT_INJECT_TOKENS = 1_200;

/** Cap injected text at an exact character budget, truncating whole lines. */
export function capText(text, maxChars = DEFAULT_MAX_CHARS) {
  const value = typeof text === "string" ? text : "";
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  const note = `\n[harnmem] context truncated to ${maxChars} characters`;
  const budget = Math.max(0, maxChars - note.length);
  const lines = value.split("\n");
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const next = used === 0 ? line.length : used + 1 + line.length;
    if (next > budget) break;
    kept.push(line);
    used = next;
  }
  const body = kept.length > 0 ? kept.join("\n") : value.slice(0, budget);
  return { text: body + note, truncated: true };
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function makeLogger(debug) {
  return (level, message, data) => {
    if (!debug && level !== "error" && level !== "warn") return;
    let line = `[harnmem-hermes] ${level}: ${message}`;
    if (data !== undefined) {
      try {
        line += ` ${typeof data === "string" ? data : JSON.stringify(data)}`;
      } catch {
        line += " [unserializable]";
      }
    }
    process.stderr.write(`${line}\n`);
  };
}

let corePromise = null;

async function loadCore() {
  if (corePromise === null) {
    corePromise = import(pathToFileURL(vendorEntry).href).catch((error) => {
      corePromise = null;
      throw new Error(
        `vendored @harnmem/core is missing at ${vendorEntry} (${error instanceof Error ? error.message : String(error)}); ` +
          "reinstall the plugin or run `pnpm --filter hermes-harnmem build`",
      );
    });
  }
  return corePromise;
}

/**
 * Build the extraction LLM from the payload plus the child environment.
 *
 * The Python side resolves the API key through Hermes' profile-aware secret
 * scope and passes it in this process' environment only, so the payload that
 * may be written to disk never carries a credential. When the environment has
 * no key, fall back to the standalone ``HARNMEM_LLM_*`` configuration.
 */
function buildLlm(payload) {
  const options = payload.llm ?? {};
  const key = (process.env.HARNMEM_LLM_API_KEY ?? "").trim();
  if (key) {
    const configured = createLlm({
      url: options.url,
      model: options.model,
      apiKey: key,
      timeoutMs: options.timeoutMs,
    });
    if (configured) return configured;
  }
  return createLlmFromEnv();
}

async function openEngine(core, payload) {
  const debug = payload.debug === true;
  const config = {
    harness: typeof payload.harness === "string" && payload.harness ? payload.harness : "hermes",
    cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd(),
    readOnly: payload.readOnly === true,
    budget: { injectTokens: positiveInt(payload.injectTokens ?? payload.budgetInjectTokens, DEFAULT_INJECT_TOKENS) },
    write: { autoExtract: payload.autoExtract === true },
    log: makeLogger(debug),
  };
  if (typeof payload.home === "string" && payload.home.trim() !== "") config.home = payload.home.trim();
  if (typeof payload.project === "string" && payload.project.trim() !== "") config.project = payload.project.trim();
  if (typeof payload.sessionId === "string" && payload.sessionId.trim() !== "") config.sessionId = payload.sessionId.trim();
  if (config.write.autoExtract) {
    config.llm = buildLlm(payload);
  }
  return core.HarnMem.open(config);
}

function sessionStartInput(payload) {
  const input = {
    cwd: configCwd(payload),
    reason: typeof payload.reason === "string" && payload.reason ? payload.reason : "session_start",
  };
  if (typeof payload.sessionId === "string" && payload.sessionId.trim() !== "") input.sessionId = payload.sessionId.trim();
  if (typeof payload.date === "string" && payload.date.trim() !== "") input.date = payload.date.trim();
  return input;
}

function configCwd(payload) {
  return typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
}

const COMMANDS = {
  async ping() {
    const core = await loadCore();
    return { apiVersion: core.HARNMEM_API_VERSION, node: process.version };
  },

  async context(core, payload) {
    const maxChars = positiveInt(payload.maxChars, DEFAULT_MAX_CHARS);
    const engine = await openEngine(core, payload);
    try {
      const block = await engine.sessionStart(sessionStartInput(payload));
      const capped = capText(block.text, maxChars);
      return {
        text: capped.text,
        truncated: capped.truncated,
        ids: block.ids,
        tokensEstimate: block.tokensEstimate,
        reason: block.reason,
        snapshotAt: block.snapshotAt,
        bytes: Buffer.byteLength(capped.text, "utf8"),
      };
    } finally {
      await engine.close();
    }
  },

  async "session-end"(core, payload) {
    const engine = await openEngine(core, payload);
    try {
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      const input = { messages };
      if (typeof payload.sessionId === "string" && payload.sessionId.trim() !== "") input.sessionId = payload.sessionId.trim();
      if (typeof payload.cwd === "string" && payload.cwd) input.cwd = payload.cwd;
      if (typeof payload.reason === "string" && payload.reason) input.reason = payload.reason;
      if (payload.skipExtract === true) input.skipExtract = true;
      return await engine.sessionEnd(input);
    } finally {
      await engine.close();
    }
  },

  async write(core, payload) {
    const input = payload.input;
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw usageError("write requires an `input` object");
    }
    const engine = await openEngine(core, payload);
    try {
      return await engine.write(input);
    } finally {
      await engine.close();
    }
  },

  async search(core, payload) {
    if (typeof payload.query !== "string" || payload.query.trim() === "") {
      throw usageError("search requires a non-empty `query`");
    }
    const engine = await openEngine(core, { ...payload, readOnly: true });
    try {
      const opts = { query: payload.query.trim() };
      if (payload.limit !== undefined) opts.limit = positiveInt(payload.limit, 8);
      if (payload.scope !== undefined) opts.scope = payload.scope;
      if (payload.project !== undefined) opts.project = payload.project;
      if (payload.includeArchived === true) opts.includeArchived = true;
      if (payload.includeHistory === true) opts.includeHistory = true;
      if (typeof payload.asOf === "string" && payload.asOf) opts.asOf = payload.asOf;
      if (typeof payload.entity === "string" && payload.entity) opts.entity = payload.entity;
      return await engine.search(opts);
    } finally {
      await engine.close();
    }
  },

  async read(core, payload) {
    const id = payload.id;
    if (typeof id !== "string" || id.trim() === "") throw usageError("read requires an `id`");
    const engine = await openEngine(core, { ...payload, readOnly: true });
    try {
      const opts = {};
      if (payload.includeHistory === true) opts.includeHistory = true;
      if (typeof payload.asOf === "string" && payload.asOf) opts.asOf = payload.asOf;
      return await engine.read(id.trim(), opts);
    } finally {
      await engine.close();
    }
  },

  async forget(core, payload) {
    const id = payload.id;
    if (typeof id !== "string" || id.trim() === "") throw usageError("forget requires an `id`");
    const engine = await openEngine(core, payload);
    try {
      return await engine.forget(id.trim(), { hard: payload.hard === true });
    } finally {
      await engine.close();
    }
  },

  async restore(core, payload) {
    const id = payload.id;
    if (typeof id !== "string" || id.trim() === "") throw usageError("restore requires an `id`");
    const engine = await openEngine(core, payload);
    try {
      return await engine.restore(id.trim());
    } finally {
      await engine.close();
    }
  },

  async status(core, payload) {
    const engine = await openEngine(core, { ...payload, readOnly: true });
    try {
      return await engine.stats();
    } finally {
      await engine.close();
    }
  },

  async consolidate(core, payload) {
    const engine = await openEngine(core, payload);
    try {
      const opts = {};
      if (payload.dryRun === true) opts.dryRun = true;
      if (payload.mechanicalOnly === true) opts.mechanicalOnly = true;
      if (payload.maxLlmCalls !== undefined) opts.maxLlmCalls = positiveInt(payload.maxLlmCalls, 0);
      return await engine.consolidate(opts);
    } finally {
      await engine.close();
    }
  },

  async rebuild(core, payload) {
    const engine = await openEngine(core, payload);
    try {
      await engine.rebuildIndex();
      return { rebuilt: true };
    } finally {
      await engine.close();
    }
  },
};

class UsageError extends Error {}

function usageError(message) {
  return new UsageError(message);
}

async function readPayload(argv) {
  const index = argv.indexOf("--payload");
  if (index !== -1) {
    const file = argv[index + 1];
    if (!file) throw new UsageError("--payload requires a file path");
    const raw = await readFile(file, "utf8");
    return { raw, file };
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return { raw: Buffer.concat(chunks).toString("utf8"), file: null };
}

async function main() {
  let file = null;
  try {
    const payloadSource = await readPayload(process.argv.slice(2));
    file = payloadSource.file;
    let payload;
    try {
      payload = JSON.parse(payloadSource.raw);
    } catch (error) {
      write({ ok: false, error: `invalid JSON payload: ${error instanceof Error ? error.message : String(error)}`, code: "BAD_PAYLOAD" });
      process.exitCode = 2;
      return;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      write({ ok: false, error: "payload must be a JSON object", code: "BAD_PAYLOAD" });
      process.exitCode = 2;
      return;
    }
    const command = typeof payload.command === "string" ? payload.command : "";
    const handler = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (handler === null) {
      write({ ok: false, error: `unknown command: ${command || "(missing)"}`, code: "UNKNOWN_COMMAND" });
      process.exitCode = 2;
      return;
    }
    const core = command === "ping" ? null : await loadCore();
    const result = await handler(core, payload);
    write({ ok: true, ...(result ?? {}) });
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof UsageError) {
      write({ ok: false, error: error.message, code: "USAGE" });
      process.exitCode = 2;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof Error && typeof error.code === "string" ? error.code : undefined;
    write({ ok: false, error: message, ...(code ? { code } : {}) });
    process.exitCode = 0;
  } finally {
    if (file) await rm(file, { force: true }).catch(() => {});
  }
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// Only dispatch when executed as a script: tests import `capText` directly and
// must not block on stdin.
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  // Compare real paths: the documented local-dev setup symlinks/junctions the
  // package into the Hermes plugin directory, so argv[1] can be a linked path
  // while Node resolves the module through its target. Windows also treats
  // drive letters case-insensitively.
  try {
    const invoked = realpathSync(entry);
    const module = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === "win32"
      ? invoked.toLowerCase() === module.toLowerCase()
      : invoked === module;
  } catch {
    try {
      return path.resolve(entry) === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  }
}

if (isEntryPoint()) await main();
