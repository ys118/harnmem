/**
 * Per-agent session lifecycle: one HarnMem engine per root agent.
 *
 * Hook mapping (docs/design/08-dsh-adapter.md §3):
 * - `agent/created`   → open engine, sessionStart, prime snapshot
 * - `agent/pre-step`  → budgeted snapshot refresh, then next()
 * - `session/event`   → append digest entries; compaction marks dirty
 * - `turn/end`        → write counter (periodic consolidation)
 * - `agent/disposed`  → bounded sessionEnd + close
 * - `session/disposed` / `context.effect` cleanup → close everything
 */

import { HarnMem, renderHotContextSync, type ContextBlock, type HarnMemConfig, type LlmFn } from "@harnmem/core";
import type { EffectiveSettings } from "./config.js";
import { TranscriptDigest, digestFromEvent } from "./digest.js";
import type { HostAgent, HostContext } from "./host.js";
import { Logger } from "./log.js";
import { createLlm, type LlmHandle } from "./llm.js";
import { PRE_STEP_BUDGET_MS, SnapshotManager, errorMessage } from "./snapshot.js";

/** Child agents (subagents) are read-only: they must not write or extract. */
export function isChildAgent(agent: HostAgent | undefined): boolean {
  if (!agent) return false;
  const header = agent.session.header;
  if (header && typeof header.delegationDepth === "number" && header.delegationDepth > 0) return true;
  if (header && typeof header.parentSession === "string" && header.parentSession !== "") return true;
  const depth = agent.options?.subagentDepth;
  return typeof depth === "number" && depth > 0;
}

export interface AgentSession {
  agent: HostAgent;
  sessionId: string;
  cwd: string;
  readOnly: boolean;
  settings: EffectiveSettings;
  log: Logger;
  llm: LlmHandle | null;
  engine: HarnMem | null;
  opening: Promise<HarnMem | null> | null;
  snapshot: SnapshotManager;
  digest: TranscriptDigest;
  /** memory_write actions performed by the model in this session. */
  modelWrites: number;
  turns: number;
  startedAt: number;
  closed: boolean;
  /** In-flight dispose; concurrent callers (agent + session events) share it. */
  ending: Promise<void> | null;
  /** In-flight resume catch-up extraction; dispose joins it before closing. */
  catchup: Promise<void> | null;
}

export class SessionManager {
  private readonly states = new Map<string, AgentSession>();

  constructor(
    private readonly ctx: HostContext,
    private readonly settings: EffectiveSettings,
    private readonly log: Logger,
  ) {}

  get(sessionId: string): AgentSession | undefined {
    return this.states.get(sessionId);
  }

  forAgent(agent: HostAgent | undefined): AgentSession | undefined {
    if (!agent) return undefined;
    return this.states.get(agent.session.id);
  }

  /**
   * Synchronous text for the system-prompt section callback.
   *
   * The host assembles the prompt before `agent/pre-step` runs and before the
   * async attach finishes, so on the first turn the in-memory snapshot can
   * still be empty. Falling back to `renderHotContextSync` reads the persisted
   * index directly and keeps injection available from the first turn. Once the
   * snapshot is primed, it wins (it is byte-stable and reflects `memory_write`).
   */
  textFor(agent: HostAgent | undefined): string {
    const state = this.forAgent(agent);
    if (!state) return "";
    const snapshot = state.snapshot.text();
    if (snapshot !== "") return snapshot;
    try {
      return renderHotContextSync({
        home: state.settings.home,
        cwd: state.cwd,
        config: {
          budget: { injectTokens: state.settings.injectMaxTokens, hotEntries: state.settings.hotEntries },
        },
      }).text;
    } catch (err) {
      state.log.warn("snapshot.coldStartFailed", { sessionId: state.sessionId, error: errorMessage(err) });
      return "";
    }
  }

  /** `agent/created` — open the engine and inject the first snapshot. */
  async attach(agent: HostAgent, reason: "session_start" | "resume" = "session_start"): Promise<AgentSession> {
    const existing = this.states.get(agent.session.id);
    if (existing) {
      if (reason === "resume") await existing.snapshot.refresh("resume", this.settings.llmTimeoutMs);
      return existing;
    }
    const log = this.log;
    const sessionId = agent.session.id;
    const cwd = agent.session.header?.cwd ?? process.cwd();
    const readOnly = isChildAgent(agent);
    const llm = readOnly ? null : createLlm(this.ctx, agent, log);
    let state: AgentSession | null = null;
    const engineRef = (): HarnMem | null => state?.engine ?? null;

    state = {
      agent,
      sessionId,
      cwd,
      readOnly,
      settings: this.settings,
      log,
      llm,
      engine: null,
      opening: null,
      snapshot: new SnapshotManager(engineRef, log),
      digest: new TranscriptDigest(),
      modelWrites: 0,
      turns: 0,
      startedAt: Date.now(),
      closed: false,
      ending: null,
      catchup: null,
    };
    this.states.set(sessionId, state);
    log.debug("session.created", { sessionId, cwd, readOnly, llm: llm?.label ?? null });

    const engine = await this.open(state);
    if (!engine) {
      // Degraded mode: injection stays empty, tools report unavailable.
      log.warn("session.degraded", { sessionId });
      return state;
    }
    try {
      const block = await engine.sessionStart({ sessionId, cwd, reason });
      state.snapshot.prime(block, reason);
      state.log.debug("session.started", {
        sessionId,
        bytes: Buffer.byteLength(block.text, "utf8"),
        ids: block.ids.length,
      });
    } catch (err) {
      state.log.warn("session.startFailed", { sessionId, error: errorMessage(err) });
      const empty: ContextBlock = { text: "", reason, snapshotAt: Date.now(), ids: [], tokensEstimate: 0 };
      state.snapshot.prime(empty, reason);
    }
    // Rehydrate the digest from the persisted journal: DSH resumes a session in
    // a new process without replaying old events, so a process-local digest
    // would never reach the extraction gates at the next quit (N2).
    if (!readOnly) {
      try {
        const history = await engine.readSessionJournal(sessionId);
        if (history.length > 0) {
          state.digest.seed(history);
          state.log.debug("digest.hydrated", {
            sessionId,
            entries: history.length,
            userMessages: state.digest.userMessages(),
          });
        }
      } catch (err) {
        state.log.warn("digest.hydrateFailed", { sessionId, error: errorMessage(err) });
      }
    }
    // Resume catch-up (N2 quit path): a desktop quit tears the provider
    // adapters down before `plugin_unload`, so the dispose-time sessionEnd can
    // no longer reach a model (observed `code=NO_ADAPTER` at the real quit).
    // The journal is durable though — finish the extraction at the *next*
    // attach while the LLM service is alive. Core's audit dedupe keeps this
    // idempotent across processes.
    this.scheduleCatchUp(state);
    return state;
  }

  /** Start a background catch-up when a hydrated journal is worth extracting. */
  private scheduleCatchUp(state: AgentSession): void {
    if (state.readOnly || state.closed || state.catchup) return;
    if (state.digest.userMessages() < state.settings.minUserMessages) return;
    state.catchup = this.runCatchUp(state).finally(() => {
      state.catchup = null;
    });
  }

  private async runCatchUp(state: AgentSession): Promise<void> {
    const engine = state.engine;
    if (!engine) return;
    try {
      const result = await engine.sessionEnd({
        sessionId: state.sessionId,
        cwd: state.cwd,
        messages: state.digest.snapshot(),
        reason: "resume_catchup",
      });
      state.log.info("extract.catchup", {
        sessionId: state.sessionId,
        status: result.status,
        added: result.added.length,
        superseded: result.superseded.length,
        skipped: result.skipped,
        skipReason: result.skipReason ?? null,
        error: result.error ?? null,
        digestEntries: state.digest.snapshot().length,
        userMessages: state.digest.userMessages(),
      });
    } catch (err) {
      state.log.warn("extract.catchupFailed", { sessionId: state.sessionId, error: errorMessage(err) });
    }
  }

  /** Open (or reuse) the core engine for a state. Concurrent callers share one open. */
  private async open(state: AgentSession): Promise<HarnMem | null> {
    if (state.engine) return state.engine;
    if (state.opening) return state.opening;
    const cfg: HarnMemConfig = {
      home: state.settings.home,
      harness: "dsh",
      sessionId: state.sessionId,
      cwd: state.cwd,
      readOnly: state.readOnly,
      llm: state.llm?.fn ?? null,
      budget: { injectTokens: state.settings.injectMaxTokens, hotEntries: state.settings.hotEntries },
      write: {
        autoExtract: state.settings.autoExtract,
        llmTimeoutMs: state.settings.llmTimeoutMs,
        minUserMessages: state.settings.minUserMessages,
      },
      governance: { consolidateEveryWrites: state.settings.consolidateEveryWrites },
      log: (level: string, message: string, data?: unknown) => {
        if (level === "warn" || level === "error") state.log.warn(message, data);
        else state.log.debug(message, data);
      },
    };
    const promise = HarnMem.open(cfg)
      .then((engine) => {
        state.engine = engine;
        return engine;
      })
      .catch((err: unknown) => {
        state.log.warn("engine.openFailed", { error: errorMessage(err) });
        return null;
      })
      .finally(() => {
        state.opening = null;
      });
    state.opening = promise;
    return promise;
  }

  /** Ensure an engine exists before tool use (tools may run before attach settles). */
  async requireEngine(state: AgentSession): Promise<HarnMem | null> {
    if (state.closed) return null;
    if (state.engine) return state.engine;
    return this.open(state);
  }

  /**
   * `agent/pre-step` — refresh when dirty or the local day rolled over. The host
   * awaits this, so a failing refresh must never block the turn: it falls back
   * to the previous snapshot.
   */
  async preStep(state: AgentSession): Promise<void> {
    if (state.closed) return;
    await state.snapshot.ensureFresh("always", PRE_STEP_BUDGET_MS);
  }

  /** `session/event` — digest accumulation plus compaction-driven rebuild. */
  onSessionEvent(state: AgentSession, event: unknown): void {
    const item = digestFromEvent(event);
    if (item) state.digest.add(item);
    const type = typeof event === "object" && event !== null ? (event as { type?: unknown }).type : undefined;
    if (type === "compaction/summary" || type === "compaction/end") {
      state.snapshot.markDirty("compaction");
      void state.snapshot.refresh("compaction", PRE_STEP_BUDGET_MS);
      state.log.debug("session.compacted", { sessionId: state.sessionId });
    }
  }

  /** `turn/end` — optional periodic consolidation. */
  onTurnEnd(state: AgentSession): void {
    state.turns += 1;
    const every = state.settings.consolidateEveryWrites;
    if (every > 0 && state.modelWrites > 0 && state.modelWrites % every === 0) {
      const engine = state.engine;
      if (!engine) return;
      void engine
        .consolidate({ mechanicalOnly: true })
        .then((report) =>
          state.log.debug("consolidate.done", {
            runId: report.runId,
            merged: report.merged.length,
            archived: report.archived.length,
            llmCalls: report.llmCalls,
          }),
        )
        .catch((err: unknown) => state.log.warn("consolidate.failed", { error: errorMessage(err) }));
    }
  }

  /** Called after the model wrote a memory; keeps the injected snapshot fresh. */
  async afterModelWrite(state: AgentSession): Promise<void> {
    state.modelWrites += 1;
    state.snapshot.markDirty("memory_write");
    await state.snapshot.ensureFresh("memory_write", this.settings.llmTimeoutMs);
  }

  /**
   * `agent/disposed` — bounded extraction then close. Idempotent: the host may
   * fire both `agent/disposed` and `session/disposed` (or a reload may race a
   * dispose), and a second run must join the first instead of double-extracting.
   */
  async dispose(state: AgentSession, reason: string = "agent_disposed"): Promise<void> {
    if (state.ending) return state.ending;
    state.ending = (async () => {
      // Join a catch-up that started at attach: it is the one extraction with
      // live providers, so never close the engine out from under it.
      if (state.catchup) {
        try {
          await state.catchup;
        } catch {
          // runCatchUp already logs its own failures
        }
      }
      await this.runDispose(state, reason);
    })().finally(() => {
      state.ending = null;
    });
    return state.ending;
  }

  private async runDispose(state: AgentSession, reason: string): Promise<void> {
    if (state.closed) return;
    state.closed = true;
    const engine = state.engine;
    if (engine) {
      const disposeStartedAt = Date.now();
      const timeout = new Promise<"timeout">((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), state.settings.llmTimeoutMs);
        timer.unref?.();
      });
      try {
        // The digest only holds this process's events. When it falls short of
        // the extraction gate, substitute the persisted journal: a restarted
        // desktop session is exactly the normal trial case, and its old prompts
        // must not be lost to a process boundary (N2 quit path).
        let messages = state.digest.snapshot();
        if (messages.filter((message) => message.role === "user").length < state.settings.minUserMessages) {
          try {
            const history = await engine.readSessionJournal(state.sessionId);
            const users = history.filter((message) => message.role === "user").length;
            if (users > messages.filter((message) => message.role === "user").length) {
              messages = history;
              state.log.debug("session.endHydrated", {
                sessionId: state.sessionId,
                messages: history.length,
                userMessages: users,
              });
            }
          } catch (err) {
            state.log.warn("session.endHydrateFailed", {
              sessionId: state.sessionId,
              error: errorMessage(err),
            });
          }
        }
        const digest = {
          digestEntries: messages.length,
          userMessages: messages.filter((message) => message.role === "user").length,
        };
        const result = await Promise.race([
          engine.sessionEnd({
            sessionId: state.sessionId,
            cwd: state.cwd,
            messages,
            reason,
          }),
          timeout,
        ]);
        if (result === "timeout") {
          state.log.warn("session.endTimeout", {
            sessionId: state.sessionId,
            ms: state.settings.llmTimeoutMs,
            elapsedMs: Date.now() - disposeStartedAt,
            ...digest,
          });
        } else {
          // info (not debug): extraction outcomes must survive `log: "errors"`
          // and the default host sink levels — this line is the runbook's proof.
          state.log.info("session.end", {
            sessionId: state.sessionId,
            status: result.status,
            added: result.added.length,
            superseded: result.superseded.length,
            skipped: result.skipped,
            skipReason: result.skipReason ?? null,
            ...digest,
            turns: state.turns,
            elapsedMs: Date.now() - disposeStartedAt,
            sessionAgeMs: Date.now() - state.startedAt,
            reason,
          });
        }
      } catch (err) {
        state.log.warn("session.endFailed", { sessionId: state.sessionId, error: errorMessage(err) });
      }
      try {
        await engine.close();
      } catch (err) {
        state.log.warn("engine.closeFailed", { sessionId: state.sessionId, error: errorMessage(err) });
      }
    }
    this.states.delete(state.sessionId);
    state.log.debug("session.disposed", { sessionId: state.sessionId, sessionAgeMs: Date.now() - state.startedAt });
  }

  /** Close every remaining engine (context unload / session disposed). */
  async closeAll(): Promise<void> {
    const states = [...this.states.values()];
    for (const state of states) {
      try {
        await this.dispose(state, "plugin_unload");
      } catch (err) {
        this.log.warn("session.closeAllFailed", { sessionId: state.sessionId, error: errorMessage(err) });
      }
    }
  }
}

export type { LlmFn };
