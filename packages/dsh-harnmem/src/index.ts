/**
 * `dsh-harnmem` — HarnMem memory for DSH.
 *
 * Plugin exports (cordis): `name`, `inject`, `Config`, `apply`. Named exports
 * only: a default export loses `inject` (see docs/research/dsh-impl-notes.md).
 *
 * Mapping design: docs/design/08-dsh-adapter.md §3–§6.
 */

import { Config, resolveSettings } from "./config.js";
import type { HostAgent, HostContext, UnknownRecord } from "./host.js";
import { createLogger, logFilePath } from "./log.js";
import { registerPanelApi } from "./panel-api.js";
import { SessionManager } from "./sessions.js";
import { errorMessage } from "./snapshot.js";
import { TOOL_SUFFIXES, registerTools } from "./tools.js";

export const name = "dsh-harnmem";

/**
 * Services this plugin reads. `llm` is deliberately NOT injected: a profile
 * without a provider must still mount (the engine then skips extraction with
 * `no_llm`), and `ctx.get("llm")` is optional at runtime.
 */
export const inject = ["systemPrompt", "tools"];

export { Config };

/** Best-effort extraction of a host agent from an event payload. */
function extractAgent(payload: unknown): HostAgent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as UnknownRecord;
  const agent = record["agent"];
  if (typeof agent === "object" && agent !== null) {
    const session = (agent as UnknownRecord)["session"];
    if (typeof session === "object" && session !== null && typeof (session as UnknownRecord)["id"] === "string") {
      return agent as HostAgent;
    }
  }
  const session = record["session"];
  if (typeof session === "object" && session !== null) {
    const inner = session as UnknownRecord;
    if (typeof inner["id"] === "string") return { session: inner as unknown as HostAgent["session"] };
  }
  return undefined;
}

function extractSessionId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as UnknownRecord;
  const candidate = record["session"] ?? record;
  if (typeof candidate === "object" && candidate !== null) {
    const id = (candidate as UnknownRecord)["id"];
    if (typeof id === "string") return id;
  }
  return undefined;
}

export async function apply(ctx: HostContext, config?: unknown): Promise<void> {
  const settings = resolveSettings(config);
  // The file sink is the DSH counterpart of pi's ~/.harnmem/logs/pi.jsonl: it
  // makes extraction outcomes and registration failures observable (N2).
  const logFile = settings.log === "off" ? undefined : logFilePath(settings.home);
  const log = createLogger(
    {
      ...(logFile ? { file: logFile } : {}),
      enabled: settings.log !== "off",
      level: settings.log === "on" ? "debug" : "error",
    },
    ctx.logger,
  );
  const sessions = new SessionManager(ctx, settings, log);
  log.debug("plugin.apply", {
    home: settings.home,
    injectMaxTokens: settings.injectMaxTokens,
    hotEntries: settings.hotEntries,
    autoExtract: settings.autoExtract,
    projectScope: settings.projectScope,
    llmTimeoutMs: settings.llmTimeoutMs,
    toolPrefix: settings.toolPrefix,
    log: settings.log,
    logFile: logFile ?? null,
  });

  // --- injection section (08 §4): synchronous, in-memory, byte-stable -------
  try {
    const systemPrompt = ctx.systemPrompt;
    if (systemPrompt) {
      systemPrompt.section({
        name: "harnmem:hot-index",
        // 4000 is dsh-auto-memory's section order; 4050 keeps the composed
        // prompt deterministic when both plugins are installed (auto-memory
        // first, then HarnMem's live hot index).
        order: 4050,
        text: (context) => sessions.textFor(context?.agent),
      });
    } else {
      log.warn("systemPrompt.unavailable", { reason: "ctx.systemPrompt is missing; injection-only skipped" });
    }
  } catch (err) {
    log.warn("section.registerFailed", { error: err instanceof Error ? err.message : String(err) });
  }

  // --- event hooks ---------------------------------------------------------
  const on = (event: string, handler: (...args: unknown[]) => unknown): void => {
    try {
      ctx.on(event, handler);
    } catch (err) {
      log.warn("event.registerFailed", { event, error: err instanceof Error ? err.message : String(err) });
    }
  };

  on("agent/created", (...args: unknown[]) => {
    const agent = extractAgent(args[0]);
    if (!agent) return;
    void sessions.attach(agent, "session_start").catch((err: unknown) => {
      log.warn("session.attachFailed", { error: err instanceof Error ? err.message : String(err) });
    });
  });

  // `agent/session-start` is unverified in DSH 0.2.1 (R3): registered
  // defensively; resume refreshes the snapshot in place.
  on("agent/session-start", (...args: unknown[]) => {
    const agent = extractAgent(args[0]);
    if (!agent) return;
    void sessions.attach(agent, "resume").catch((err: unknown) => {
      log.warn("session.resumeFailed", { error: err instanceof Error ? err.message : String(err) });
    });
  });

  on("agent/pre-step", async (...args: unknown[]) => {
    const payload = args[0];
    const next = args[1];
    const agent = extractAgent(payload);
    const state = agent ? sessions.forAgent(agent) : undefined;
    if (state) {
      try {
        await sessions.preStep(state);
      } catch (err) {
        // fail closed: the previous snapshot keeps serving this turn.
        log.warn("preStep.failed", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return typeof next === "function" ? (next as () => unknown)() : undefined;
  });

  on("session/event", (...args: unknown[]) => {
    const sessionId = extractSessionId(args[0]);
    const event = args[1];
    if (!sessionId) return;
    const state = sessions.get(sessionId);
    if (!state) return;
    try {
      sessions.onSessionEvent(state, event);
    } catch (err) {
      log.warn("session.eventFailed", { error: err instanceof Error ? err.message : String(err) });
    }
  });

  on("turn/end", (...args: unknown[]) => {
    const agent = extractAgent(args[0]);
    const state = agent ? sessions.forAgent(agent) : undefined;
    if (state) sessions.onTurnEnd(state);
  });

  on("agent/disposed", (...args: unknown[]) => {
    const agent = extractAgent(args[0]);
    const state = agent ? sessions.forAgent(agent) : undefined;
    if (!state) return;
    // Return the promise: hosts that await event handlers then wait for the
    // bounded extraction instead of racing process teardown (N2, 08 §3.4).
    return sessions.dispose(state, "agent_disposed").catch((err: unknown) => {
      log.warn("session.disposeFailed", { error: errorMessage(err) });
    });
  });

  on("session/disposed", (...args: unknown[]) => {
    const sessionId = extractSessionId(args[0]);
    const state = sessionId ? sessions.get(sessionId) : undefined;
    if (!state) return;
    return sessions.dispose(state, "session_disposed").catch((err: unknown) => {
      log.warn("session.disposeFailed", { error: errorMessage(err) });
    });
  });

  // --- tools (08 §5): failure degrades to injection-only --------------------
  try {
    await registerTools({ ctx, sessions, log, toolPrefix: settings.toolPrefix });
  } catch (err) {
    log.warn("tools.setupFailed", { error: errorMessage(err) });
  }

  // --- panel API (read-only): installs now, or when `connection` shows up ----
  // Registered after the tools so a failed tool bootstrap never hides the panel,
  // and before the cleanup effect so its dispose joins the same unload path.
  // `connection` may mount asynchronously; panel-api waits for it via ctx.inject
  // and stays a silent no-op in hosts that never provide it.
  const disposePanelApi = registerPanelApi({ ctx, sessions, log, settings });

  // --- unload cleanup: never leave engines open, never lose queued log lines -
  try {
    ctx.effect?.(function* cleanup() {
      yield async () => {
        try {
          await disposePanelApi();
        } catch (err) {
          log.warn("panel.api.disposeFailed", { error: errorMessage(err) });
        }
        try {
          await sessions.closeAll();
        } finally {
          await log.flush();
        }
      };
    });
  } catch (err) {
    log.warn("effect.registerFailed", { error: errorMessage(err) });
  }

  log.debug("plugin.ready", { tools: TOOL_SUFFIXES.length, toolPrefix: settings.toolPrefix });
}
