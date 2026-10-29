/**
 * opencode-harnmem: HarnMem plugin for opencode v2 (domain plugin API).
 *
 * Contract: docs/design/07-adapter-contract.md (v1). Verified against the
 * opencode v2.1.4 binary — see docs/research/opencode-plugin.md for the
 * full probe evidence. Loading shape (hard requirement, probed):
 *
 *   export default { id, setup(ctx) }   // plain object, setup = async fn
 *
 * Four layers, all in-process (no MCP server, no transcript files):
 *   1. Injection  — ctx.session.hook("context"): push one byte-stable part
 *                   into inp.system on every LLM request (cached per session).
 *   2. Tools      — ctx.tool.transform: native memory_write/search/read/
 *                   forget/status with plain JSON-Schema args (no zod).
 *   3. Lifecycle  — ctx.session.hook("prompt"): journal the transcript tail
 *                   via eng.sessionEnd each turn; abrupt exits lose at most
 *                   the current turn (no end-hook needed).
 *   4. Config     — lib/settings.mjs (env > ~/.harnmem/config.json > project).
 *
 * Every failure is swallowed with a debug log: the session must always
 * proceed (adapter contract: extraction/injection is bounded, never fatal).
 */

import { openEngine } from "./lib/engine.mjs";
import { resolveSettings } from "./lib/settings.mjs";
import { formatWrite, formatSearch, formatRead, formatForget, formatStats } from "./lib/format.mjs";

const MAX_INJECT_BYTES = 10_000;
const MAX_MESSAGES = 400;
const MAX_TEXT_CHARS = 4000;
// Per-(session, cwd, mode) engines: core keeps session-scoped mutable state
// (write provenance `source.session`, modelWrites/extracted suppression
// counters), so sharing one engine across sessions would misattribute writes
// and leak suppression across sessions. Read-only (subagent) engines are keyed
// separately from read-write ones so a child session can never poison the
// main session's write path with a read-only engine (review round 2, M1/M2).
const MAX_ENGINES = 8;

const MEMORY_TYPES = ["user", "feedback", "project", "reference"];
const CATEGORIES = ["profile", "preference", "decision", "convention", "lesson", "pitfall", "state", "external"];
const SCOPES = ["auto", "user", "project"];
/** memory_search scope: SearchOptions.scope has no "auto" mode (write-only concept). */
const SEARCH_SCOPES = ["user", "project", "all"];

/**
 * Major version from an opencode version string ("2.1.4" -> 2). Returns null
 * when unparseable (callers treat null as "unknown, proceed").
 */
export function pluginVersionMajor(version) {
  const m = /^(\d+)/.exec(String(version ?? ""));
  return m ? Number(m[1]) : null;
}

/** Deterministic truncation to the injection byte cap (same rule as claude). */
export function capBytes(text, maxBytes = MAX_INJECT_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "\n<!-- harnmem: snapshot truncated to fit the injection cap -->";
  const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
  const out = [];
  let used = 0;
  for (const line of text.split("\n")) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  return out.join("\n") + suffix;
}

/**
 * opencode session.context() messages -> core TranscriptMessage[]
 * ({role, text, ts?}). Tolerant by design: unknown shapes are skipped,
 * never fatal. Reasoning blocks are excluded (same rule as the claude
 * transcript parser); text is truncated per message and the tail is kept.
 */
export function toCoreMessages(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const role = m.type;
    if (role !== "user" && role !== "assistant") continue;
    let text = typeof m.text === "string" ? m.text : "";
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const block of m.content) {
        if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
      if (parts.length) text = parts.join("\n");
    }
    text = String(text || "").trim();
    if (!text) continue;
    if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS);
    let ts;
    const t = m.time?.created ?? m.time?.created_at;
    if (typeof t === "number" && Number.isFinite(t)) ts = t;
    else if (typeof t === "string") {
      const parsed = Date.parse(t);
      if (Number.isFinite(parsed)) ts = parsed;
    }
    out.push({ role, text, ...(ts !== undefined ? { ts } : {}) });
  }
  return out.slice(-MAX_MESSAGES);
}

/**
 * Tools may receive a bare JSON value instead of an object when the model
 * emits non-object arguments (probed: args `"test"` for a single-string
 * schema). Map a bare value onto the single required property; otherwise
 * pass objects through untouched.
 */
export function normalizeArgs(args, requiredKey) {
  if (args === null || args === undefined) return {};
  if (typeof args === "object" && !Array.isArray(args)) return args;
  if (requiredKey && (typeof args === "string" || typeof args === "number" || typeof args === "boolean")) {
    return { [requiredKey]: args };
  }
  return {};
}

/** Testable plugin core. `deps` overrides are for unit tests only. */
export function createPluginState(deps = {}) {
  const state = {
    ctx: null,
    fallbackCwd: process.cwd(),
    engines: new Map(), // `${mode}:${cwd}#${sessionId}` -> engine (session-owned, LRU-capped)
    opening: new Map(), // same key -> in-flight open promise (concurrent first-touch dedupe)
    sessions: new Map(), // sessionID -> {id, cwd, readOnly, injectText, journalSig}
    settingsCache: new Map(), // cwd -> resolved settings (process-lifetime by design; see resolveSettings)
    deps,

    debug(msg, data) {
      try {
        // Plugin-level gate: the fallback-cwd settings decide verbosity.
        if (!this._debug) return;
        process.stderr.write(`[harnmem:debug] ${msg}${data === undefined ? "" : " " + JSON.stringify(data)}\n`);
      } catch {
        // best effort
      }
    },

    settingsFor(cwd) {
      let settings = this.settingsCache.get(cwd);
      if (!settings) {
        settings = resolveSettings(cwd, process.env);
        this.settingsCache.set(cwd, settings);
        if (settings.debug) this._debug = true;
      }
      return settings;
    },

    async sessionInfo(sessionId) {
      let sess = this.sessions.get(sessionId);
      if (sess) return sess;
      sess = { id: sessionId, cwd: this.fallbackCwd, readOnly: false, injectText: undefined, journalSig: null };
      try {
        // Probed: parameter is an object; the record carries per-session cwd.
        const rec = await this.ctx.session.get({ sessionID: sessionId });
        if (rec && typeof rec === "object") {
          if (rec.parentID) sess.readOnly = true; // child/subagent session
          const dir = rec.location?.directory ?? rec.directory;
          if (typeof dir === "string" && dir.trim()) sess.cwd = dir;
        }
      } catch (err) {
        this.debug("session.get.failed", { sessionId, error: String(err?.message || err) });
      }
      this.sessions.set(sessionId, sess);
      return sess;
    },

    async engineFor(sess) {
      const key = `${sess.readOnly ? "ro" : "rw"}:${sess.cwd}#${sess.id}`;
      const cached = this.engines.get(key);
      if (cached) {
        // Refresh recency: Maps iterate in insertion order, so re-inserting
        // turns the FIFO structure into a real LRU.
        this.engines.delete(key);
        this.engines.set(key, cached);
        return cached;
      }
      const inflight = this.opening.get(key);
      if (inflight) return inflight; // concurrent first touch: one open only
      const settings = this.settingsFor(sess.cwd);
      const open = this.deps.openEngine || openEngine;
      const opened = open(settings, {
        cwd: sess.cwd,
        sessionId: sess.id,
        readOnly: sess.readOnly || settings.readOnly === true,
      })
        .then((eng) => {
          this.engines.set(key, eng);
          if (this.engines.size > MAX_ENGINES) {
            const oldest = this.engines.keys().next().value;
            const victim = this.engines.get(oldest);
            this.engines.delete(oldest);
            if (victim && victim !== eng) {
              // Evicting an engine still used by a live session is safe:
              // core close() only flushes advisory usage counters; the next
              // touch for that key simply reopens.
              Promise.resolve(victim.close()).catch(() => {});
            }
          }
          return eng;
        })
        .finally(() => {
          this.opening.delete(key);
        });
      this.opening.set(key, opened);
      return opened;
    },

    /** Byte-stable injection text per session; "" means inject nothing. */
    async injectTextFor(sessionId) {
      const sess = await this.sessionInfo(sessionId);
      if (sess.injectText !== undefined) return sess.injectText;
      const settings = this.settingsFor(sess.cwd);
      // Static gates resolve immediately; there is nothing to retry later.
      if (!settings.enabled || !settings.inject || sess.readOnly) {
        sess.injectText = "";
        return "";
      }
      // Engine path: leave injectText undefined until success so a transient
      // openEngine failure (file lock, double-instance race) is retried on
      // the next request instead of caching "" forever (review round 2, M2).
      const eng = await this.engineFor(sess);
      const block = await eng.sessionStart({ sessionId, cwd: sess.cwd, reason: "session_start" });
      const text = capBytes(block?.text || "");
      this.debug("session-start", {
        sessionId,
        bytes: Buffer.byteLength(text, "utf8"),
        ids: block?.ids?.length ?? 0,
        readOnly: sess.readOnly,
      });
      sess.injectText = text; // empty store: inject nothing (0-byte rule)
      return text;
    },

    /**
     * Journal the transcript tail at turn start. The prompt hook fires
     * before generation, so each call captures everything up to the previous
     * turn; core writes the session journal even when extraction is
     * skipped (no_llm), which is what later extraction/consolidation reads.
     */
    async journalTurn(sessionId, reason = "turn") {
      const sess = await this.sessionInfo(sessionId);
      this.debug("journal.enter", { sessionId, readOnly: sess.readOnly });
      if (sess.readOnly) return;
      const settings = this.settingsFor(sess.cwd);
      if (!settings.enabled) return;
      const raw = await this.ctx.session.context({ sessionID: sessionId });
      const messages = toCoreMessages(raw);
      const last = messages[messages.length - 1];
      const sig = messages.length === 0 ? "0" : `${messages.length}:${last.text.slice(0, 80)}`;
      if (sig === sess.journalSig) return;
      const eng = await this.engineFor(sess);
      const result = await eng.sessionEnd({ sessionId, cwd: sess.cwd, reason, messages });
      // Only remember the signature after sessionEnd succeeded, so a failed
      // write is retried on the next turn instead of being silently dropped.
      sess.journalSig = sig;
      this.debug("journal", { sessionId, status: result?.status, messages: messages.length });
    },

    async onPrompt(inp) {
      try {
        this.debug("prompt.enter", { keys: inp && typeof inp === "object" ? Object.keys(inp) : String(inp) });
        const sessionId = inp?.sessionID;
        if (typeof sessionId !== "string" || !sessionId) return;
        await this.journalTurn(sessionId, "turn");
      } catch (err) {
        this.debug("prompt.journal.failed", { error: String(err?.message || err) });
      }
    },

    async onContext(inp) {
      try {
        const sessionId = inp?.sessionID;
        if (typeof sessionId !== "string" || !sessionId) return;
        if (!Array.isArray(inp.system)) return;
        const text = await this.injectTextFor(sessionId);
        if (text) inp.system.push({ type: "text", text });
      } catch (err) {
        this.debug("context.inject.failed", { error: String(err?.message || err) });
      }
    },

    /** Shared tool body: settings gate + engine + error containment. */
    async toolRun(toolName, args, tc, fn) {
      const fail = (msg) => ({ title: toolName, content: [{ type: "text", text: msg }], metadata: {} });
      try {
        const sessionId = tc?.sessionID;
        if (typeof sessionId !== "string" || !sessionId) return fail(`${toolName}: no session context`);
        const sess = await this.sessionInfo(sessionId);
        const settings = this.settingsFor(sess.cwd);
        if (!settings.enabled) return fail("harnmem: memory store is disabled (HARNMEM_DISABLED or config)");
        const eng = await this.engineFor(sess);
        return await fn(eng);
      } catch (err) {
        this.debug("tool.failed", { tool: toolName, error: String(err?.message || err) });
        return fail(`${toolName} failed: ${String(err?.message || err)}`);
      }
    },

    async toolWrite(rawArgs, tc) {
      const args = normalizeArgs(rawArgs);
      return this.toolRun("memory_write", args, tc, async (eng) => {
        const input = { ...args };
        // Clamp only real numbers; null/junk must be dropped entirely so
        // core's defaults apply (importance 5 / confidence 0.7), not 0.
        const clampNum = (v, lo, hi) => {
          if (v === undefined || v === null) return undefined;
          const n = Number(v);
          return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : undefined;
        };
        const imp = clampNum(input.importance, 0, 10);
        if (imp === undefined) delete input.importance;
        else input.importance = imp;
        const conf = clampNum(input.confidence, 0, 1);
        if (conf === undefined) delete input.confidence;
        else input.confidence = conf;
        const result = await eng.write(input);
        if (["NEW", "MERGE", "SUPERSEDE", "LINK"].includes(result.action)) eng.noteModelWrite();
        this.debug("tool.write", { id: result.id, action: result.action });
        return { title: "memory_write", content: [{ type: "text", text: formatWrite(result) }], metadata: { id: result.id, action: result.action } };
      });
    },

    async toolSearch(rawArgs, tc) {
      const args = normalizeArgs(rawArgs, "query");
      return this.toolRun("memory_search", args, tc, async (eng) => {
        const scope = args.scope === "auto" ? "all" : args.scope; // defensive: "auto" was a write-only concept
        const result = await eng.search({
          query: args.query,
          limit: args.limit,
          scope,
          project: args.project,
          includeArchived: args.include_archived,
          includeHistory: args.include_history,
          asOf: args.as_of,
          entity: args.entity,
          debug: args.debug,
        });
        this.debug("tool.search", { query: args.query, hits: result.results?.length, abstained: result.abstained });
        return { title: "memory_search", content: [{ type: "text", text: formatSearch(result) }], metadata: { total: result.total, abstained: result.abstained } };
      });
    },

    async toolRead(rawArgs, tc) {
      const args = normalizeArgs(rawArgs, "id");
      return this.toolRun("memory_read", args, tc, async (eng) => {
        const result = await eng.read(args.id, { asOf: args.as_of, includeHistory: args.include_history });
        this.debug("tool.read", { id: args.id, found: result !== null });
        return { title: "memory_read", content: [{ type: "text", text: formatRead(result, args.id) }], metadata: { found: result !== null } };
      });
    },

    async toolForget(rawArgs, tc) {
      const args = normalizeArgs(rawArgs, "id");
      return this.toolRun("memory_forget", args, tc, async (eng) => {
        const result = await eng.forget(args.id, { hard: args.hard === true });
        this.debug("tool.forget", { id: args.id, mode: result.mode, ok: result.ok });
        return { title: "memory_forget", content: [{ type: "text", text: formatForget(result) }], metadata: { ok: result.ok, mode: result.mode } };
      });
    },

    async toolStatus(rawArgs, tc) {
      const args = normalizeArgs(rawArgs);
      return this.toolRun("memory_status", args, tc, async (eng) => {
        const stats = await eng.stats();
        return { title: "memory_status", content: [{ type: "text", text: formatStats(stats) }], metadata: { version: stats.version } };
      });
    },

    closeAll() {
      for (const eng of this.engines.values()) {
        try {
          // close() is async (flushes advisory usage counters); swallow its
          // rejection too — the try/catch below only covers sync throws, and
          // an unhandled rejection at exit would surface as host noise.
          Promise.resolve(eng.close()).catch(() => {});
        } catch {
          // best effort on exit
        }
      }
      this.engines.clear();
    },
  };
  return state;
}

const TOOL_DESCRIPTIONS = {
  memory_write:
    "Store a durable memory (user preference, feedback/lesson, project fact, reference). " +
    "Use for facts worth remembering across sessions; do not store transient chat. " +
    "Returns a one-line outcome (NEW/SKIP/MERGE/SUPERSEDE/LINK).",
  memory_search:
    "Search long-term memory by lexical/semantic-free BM25 over titles, descriptions, tags, entities and bodies. " +
    "Use before asking the user to repeat something or before making project decisions.",
  memory_read: "Open one memory record by id (frontmatter summary + body + backlinks).",
  memory_forget:
    "Forget a memory. Default moves it to trash (restorable); hard=true deletes permanently. " +
    "Use when the user corrects a fact or asks to forget something.",
  memory_status: "Show memory store health: shards, counts, capacities and pending events. Useful before large writes.",
};

const strEnum = (values, description) => ({ type: "string", enum: [...values], ...(description ? { description } : {}) });
const strArr = (description) => ({ type: "array", items: { type: "string" }, ...(description ? { description } : {}) });
// Probed flat-args convention (probe v11): reg.add args is a flat map of
// property schemas; fields marked `optional: true` are optional, bare fields
// are required. No zod, no {type:"object",properties} wrapper.
const opt = (schema, description) => ({ ...schema, ...(description ? { description } : {}), optional: true });

const TOOL_ARGS = {
  memory_write: {
    type: strEnum(MEMORY_TYPES, "Memory type."),
    title: { type: "string", description: "Short title (<=80 chars), shown in the hot index." },
    content: { type: "string", description: "Full memory body in markdown." },
    description: { type: "string", description: "One-line description shown in search results and the hot index." },
    category: opt(strEnum(CATEGORIES), "Memory category."),
    scope: opt(strEnum(SCOPES), "user = global, project = this project, auto = decide by content."),
    project: opt({ type: "string" }),
    tags: opt(strArr()),
    entities: opt(strArr()),
    importance: opt({ type: "number" }, "0..10 (higher = more important), default 5"),
    confidence: opt({ type: "number" }, "0..1, default 0.7"),
    pinned: opt({ type: "boolean" }, "Always inject into the hot index."),
    links: opt(strArr("memory id")),
    supersedes: opt(strArr("memory id this replaces")),
    evidence: opt(strArr()),
    sensitive: opt({ type: "boolean" }, "Do not inject into the prompt; retrieval only."),
  },
  memory_search: {
    query: { type: "string", description: "Keywords, names, or a short natural-language query." },
    limit: opt({ type: "number" }, "Max results, default 8."),
    scope: opt(strEnum(SEARCH_SCOPES), "Search scope."),
    project: opt({ type: "string" }),
    include_archived: opt({ type: "boolean" }),
    include_history: opt({ type: "boolean" }),
    as_of: opt({ type: "string" }, "ISO date or epoch-ms: only facts valid at that instant."),
    entity: opt({ type: "string" }),
    debug: opt({ type: "boolean" }, "Return match diagnostics with the results."),
  },
  memory_read: {
    id: { type: "string", description: "Memory id, e.g. mem_..." },
    as_of: opt({ type: "string" }, "ISO date or epoch-ms: view the record as it was at that instant."),
    include_history: opt({ type: "boolean" }, "Include superseded versions."),
  },
  memory_forget: {
    id: { type: "string", description: "Memory id, e.g. mem_..." },
    hard: opt({ type: "boolean" }, "true = permanent delete; default move to trash"),
  },
  memory_status: {},
};

export default {
  id: "opencode-harnmem",
  setup: async (ctx) => {
    const major = pluginVersionMajor(ctx?.app?.version);
    if (major !== null && major < 2) {
      process.stderr.write(`[harnmem] opencode ${ctx?.app?.version} detected; this plugin requires opencode >= 2.x — not loaded\n`);
      return;
    }

    const state = createPluginState();
    state.ctx = ctx;
    state.fallbackCwd = (typeof ctx?.location?.directory === "string" && ctx.location.directory.trim()) || process.cwd();
    state.settingsFor(state.fallbackCwd); // prime debug gate

    // 1+3. Injection per LLM request + journaling per turn.
    const disposers = [];
    try {
      disposers.push(await ctx.session.hook("context", (inp) => state.onContext(inp)));
    } catch (err) {
      state.debug("register.context.failed", { error: String(err?.message || err) });
    }
    try {
      disposers.push(await ctx.session.hook("prompt", (inp) => state.onPrompt(inp)));
    } catch (err) {
      state.debug("register.prompt.failed", { error: String(err?.message || err) });
    }

    // 2. Native tools (probed shape: async execute -> {title, content, metadata}).
    try {
      disposers.push(
        await ctx.tool.transform((reg) => {
          reg.add({ name: "memory_write", description: TOOL_DESCRIPTIONS.memory_write, args: TOOL_ARGS.memory_write, execute: (a, tc) => state.toolWrite(a, tc) });
          reg.add({ name: "memory_search", description: TOOL_DESCRIPTIONS.memory_search, args: TOOL_ARGS.memory_search, execute: (a, tc) => state.toolSearch(a, tc) });
          reg.add({ name: "memory_read", description: TOOL_DESCRIPTIONS.memory_read, args: TOOL_ARGS.memory_read, execute: (a, tc) => state.toolRead(a, tc) });
          reg.add({ name: "memory_forget", description: TOOL_DESCRIPTIONS.memory_forget, args: TOOL_ARGS.memory_forget, execute: (a, tc) => state.toolForget(a, tc) });
          reg.add({ name: "memory_status", description: TOOL_DESCRIPTIONS.memory_status, args: TOOL_ARGS.memory_status, execute: (a, tc) => state.toolStatus(a, tc) });
        }),
      );
    } catch (err) {
      state.debug("register.tools.failed", { error: String(err?.message || err) });
    }

    state.debug("setup.done", { disposers: disposers.length, cwd: state.fallbackCwd, version: ctx?.app?.version });

    // Engines hold file handles/FTS writers; close them when the host exits.
    // Note: the exit event runs sync code only — core close() flushes advisory
    // usage counters asynchronously and that flush is lost at exit (harmless:
    // journals and memories are written at operation time). This handler is a
    // best-effort gesture, not a durability mechanism.
    process.once("exit", () => state.closeAll());

    // Disposers are collected but intentionally NOT returned: the probed v2
    // binary accepted `setup` returning void, and the semantics of a returned
    // dispose object are unverified — an unexpected return shape is a bigger
    // compatibility risk than missing hot-reload cleanup. Revisit when the
    // v2 setup contract is documented.
    return;
  },
};
