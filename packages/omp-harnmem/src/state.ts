/**
 * Adapter state: settings, the opened engine, the stable snapshot, the
 * transcript journal, and lifecycle helpers. One instance per extension load.
 *
 * Failure policy: every omp event handler is wrapped by the caller and this
 * class never throws into omp; the worst case is "memory disabled for this
 * session", logged and (optionally) surfaced via ctx.ui.notify.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { HarnMem } from "@harnmem/core";
import type { ContextReason, HarnMemConfig, ExtractResult } from "@harnmem/core";
import { resolveSettings } from "./config.js";
import type { EffectiveSettings } from "./config.js";
import { SnapshotManager } from "./context.js";
import type { Snapshot } from "./context.js";
import { TranscriptJournal } from "./journal.js";
import { createLlm } from "./llm.js";
import type { Logger } from "./log.js";
import { createLogger, logFilePath } from "./log.js";
import { detectChildSession } from "./subagent.js";

/**
 * omp gives `session_before_switch` handlers the standard ~30s budget, so a
 * switch flush may take its time like on pi.
 */
const SWITCH_EXTRACT_TIMEOUT_MS = 8_000;
/**
 * omp runs `session_shutdown` handlers concurrently under a hard ~2s budget
 * (docs/extension-loading.md; pi had no timeout). Cap quit extraction well
 * under it — quit-time extraction is best-effort on omp.
 */
const SHUTDOWN_EXTRACT_TIMEOUT_MS = 1_500;

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export class Adapter {
  settings: EffectiveSettings | null = null;
  logger: Logger | null = null;
  eng: HarnMem | null = null;
  snapshot: SnapshotManager | null = null;
  readonly journal = new TranscriptJournal();
  sessionId = "";
  cwd = "";
  isChild = false;
  childEvidence = "none";
  llmLabel: string | null = null;
  enabled = false;
  readOnly = false;
  private opening: Promise<HarnMem | null> | null = null;
  private initFailed = false;

  get isOpen(): boolean {
    return this.eng !== null;
  }

  /** Build the HarnMemConfig shared by open() and lazy re-open. */
  private buildConfig(ctx: ExtensionContext, settings: EffectiveSettings, llm: ReturnType<typeof createLlm>): HarnMemConfig {
    const log = this.logger;
    return {
      home: settings.home,
      harness: "omp",
      sessionId: this.sessionId || ctx.sessionManager.getSessionId(),
      cwd: settings.settings.project ? ctx.cwd : this.cwd || ctx.cwd,
      project: settings.settings.project,
      llm: this.readOnly || this.isChild ? null : llm?.fn ?? null,
      readOnly: this.readOnly,
      budget: settings.settings.maxInjectTokens ? { injectTokens: settings.settings.maxInjectTokens } : undefined,
      write: {
        autoExtract: settings.autoExtract && !this.isChild,
      },
      log: log
        ? (level, msg, data) => {
            if (level === "debug") log.debug(msg, asRecord(data));
            else if (level === "info") log.info(msg, asRecord(data));
            else if (level === "warn") log.warn(msg, asRecord(data));
            else log.error(msg, asRecord(data));
          }
        : undefined,
    };
  }

  /**
   * Session start: resolve config, detect child sessions, open the engine,
   * build the first byte-stable snapshot. Never throws.
   *
   * omp's `session_start` event carries no reason field; callers pass the
   * effective reason here (initial load infers "resume" from existing
   * conversational entries; `session_switch` forwards its own reason).
   */
  async start(ctx: ExtensionContext, reason: SessionStartReason): Promise<void> {
    const prevSessionId = this.sessionId;
    this.cwd = ctx.cwd;
    this.sessionId = ctx.sessionManager.getSessionId();
    try {
      this.settings = resolveSettings(ctx.cwd);
    } catch (err) {
      // resolveSettings is defensive, but stay safe.
      this.initFailed = true;
      return;
    }
    const settings = this.settings;
    const level = settings.debug ? "debug" : settings.log === "on" ? "debug" : "error";
    this.logger = createLogger({
      file: logFilePath(settings.home),
      enabled: settings.log !== "off",
      level,
    });
    this.logger.debug("session.start", {
      reason,
      cwd: ctx.cwd,
      sessionId: this.sessionId,
      sources: settings.sources,
      warnings: settings.warnings,
    });

    for (const warning of settings.warnings) this.logger.warn("config.warning", { warning });

    if (!settings.enabled) {
      this.enabled = false;
      this.logger.info("adapter.disabled", { by: "config/env" });
      return;
    }

    const child = detectChildSession(ctx);
    this.isChild = child.isChild;
    this.childEvidence = child.evidence;
    this.readOnly = settings.readOnly || child.isChild;
    if (child.isChild) {
      this.logger.info("session.child", { evidence: child.evidence, readOnly: true });
    }

    const llm = child.isChild ? null : createLlm(ctx, settings.settings, this.logger);
    this.llmLabel = llm?.label ?? null;

    this.enabled = true;
    const eng = await this.openEngine(ctx, settings, llm);
    if (!eng) {
      this.logger.warn("engine.open.failed", { home: settings.home });
      this.notify(ctx, `harnmem: failed to open store at ${settings.home}`, "warning");
      return;
    }

    // Session switch (/new, resume, fork): the journal may still hold turns
    // from the previous session. Flush them under THEIR session id (async,
    // time-capped) and clear, so quit-time extraction can never attribute a
    // previous session's messages to this one. A reload keeps the same
    // session id — nothing to flush there.
    if (prevSessionId && prevSessionId !== this.sessionId) {
      void this.flushJournal(prevSessionId, "session_switch", SWITCH_EXTRACT_TIMEOUT_MS).catch((err) => {
        this.logger?.warn("journal.switchFlush.error", { error: (err as Error).message });
      });
    }

    this.snapshot = new SnapshotManager(() => this.eng, this.logger);
    const contextReason: ContextReason = reason === "resume" ? "resume" : "session_start";
    let snap: Snapshot | null = null;
    if (settings.inject) {
      try {
        // Engine bookkeeping (session id, injection audit) + first hot-index build.
        const block = await eng.sessionStart({
          sessionId: this.sessionId,
          cwd: this.cwd,
          reason: contextReason as "session_start" | "resume",
        });
        snap = this.snapshot.prime(block, contextReason);
      } catch (err) {
        this.logger.warn("sessionStart.failed", { error: (err as Error).message });
        snap = await this.snapshot.ensureFresh(contextReason);
      }
    }
    if (snap) {
      this.logger.info("snapshot.ready", {
        sha: snap.sha,
        bytes: Buffer.byteLength(snap.block.text, "utf8"),
        ids: snap.block.ids.length,
        tokensEstimate: snap.block.tokensEstimate,
      });
      this.notifyStatus(ctx);
    }
    this.logger.debug("session.ready", {
      llm: this.llmLabel,
      readOnly: this.readOnly,
      child: this.isChild,
    });
  }

  private async openEngine(
    ctx: ExtensionContext,
    settings: EffectiveSettings,
    llm: ReturnType<typeof createLlm>,
  ): Promise<HarnMem | null> {
    if (this.eng) return this.eng;
    if (this.opening) return this.opening;
    this.opening = (async (): Promise<HarnMem | null> => {
      try {
        const opened = await HarnMem.open(this.buildConfig(ctx, settings, llm));
        this.eng = opened;
        this.initFailed = false;
        return opened;
      } catch (err) {
        this.initFailed = true;
        this.logger?.error("engine.open.error", { error: (err as Error).message, code: (err as { code?: string }).code });
        return null;
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  /**
   * Lazy engine access for tools/commands. Fails closed: if the open attempt
   * failed (`initFailed`), tools report the store as unavailable for the rest
   * of the session; a successful `start()` on the next session resets state.
   */
  async ensureEngine(ctx: ExtensionContext): Promise<HarnMem | null> {
    if (this.eng) return this.eng;
    if (!this.settings || this.initFailed) return null;
    const llm = this.isChild ? null : createLlm(ctx, this.settings.settings, this.logger ?? createLogger({ file: logFilePath(this.settings.home), enabled: false, level: "error" }));
    return this.openEngine(ctx, this.settings, llm);
  }

  markDirty(reason: ContextReason): void {
    this.snapshot?.markDirty(reason);
  }

  /** Refresh the snapshot eagerly (compaction can afford a disk read). */
  async refresh(reason: ContextReason): Promise<void> {
    if (!this.snapshot) return;
    try {
      await this.snapshot.rebuild(reason);
    } catch {
      // SnapshotManager already swallows; belt and braces.
    }
  }

  notifyStatus(ctx: ExtensionContext): void {
    if (!this.snapshot) return;
    if (!this.settings?.statusLine) {
      // `statusLine: false`: keep the footer clean; /memory status still works.
      this.logger?.debug("status.suppressed", { reason: "config" });
      return;
    }
    try {
      if (ctx.hasUI) ctx.ui.setStatus("harnmem", `harnmem: ${this.snapshot.describe()}`);
    } catch {
      // UI is optional
    }
  }

  notify(ctx: ExtensionContext, text: string, type: "info" | "warning" | "error" = "info"): void {
    try {
      if (ctx.hasUI) ctx.ui.notify(text, type);
    } catch {
      // UI is optional
    }
  }

  /**
   * Extract the current journal contents under an explicit session id, time
   * capped. Used at quit (the session's own end) and at session switches
   * (/new etc.), where leftover turns belong to the OLD session id. Clears
   * the journal immediately after snapshotting: a failed extraction loses
   * the turns either way, but a stale journal would poison the next
   * session's attribution.
   */
  private async flushJournal(sessionId: string, trigger: "quit" | "session_switch", timeoutMs: number): Promise<void> {
    const log = this.logger;
    if (!this.eng || !this.settings?.autoExtract || this.isChild) return;
    const messages = this.journal.snapshot();
    this.journal.clear();
    if (!messages.some((m) => m.role === "user")) return;
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      });
      const extraction = this.eng
        .sessionEnd({ sessionId, cwd: this.cwd, messages, reason: trigger })
        .then((result): ExtractResult => result)
        .catch((err: unknown): ExtractResult => ({ status: "failed", added: [], superseded: [], skipped: 0, error: (err as Error).message }));
      const outcome = await Promise.race([extraction, timeout]);
      if (outcome === "timeout") {
        log?.warn("endSession.timeout", { sessionId, trigger, elapsedMs: Date.now() - startedAt, messages: messages.length });
      } else {
        log?.info("endSession.done", {
          sessionId,
          trigger,
          status: outcome.status,
          added: outcome.added.length,
          superseded: outcome.superseded.length,
          skipped: outcome.skipped,
          elapsedMs: Date.now() - startedAt,
        });
      }
    } catch (err) {
      log?.warn("endSession.error", { error: (err as Error).message });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Flush the current session's journal before omp replaces it: fired from
   * `session_before_switch` / `session_before_branch`, where leftover turns
   * still belong to the OUTGOING session. Start()-based prev-session flushing
   * stays as a belt-and-braces fallback for switch paths that bypass the
   * before-events.
   */
  async flushOnSwitch(): Promise<void> {
    if (!this.sessionId) return;
    await this.flushJournal(this.sessionId, "session_switch", SWITCH_EXTRACT_TIMEOUT_MS);
  }

  /**
   * Session shutdown. omp's `session_shutdown` event carries no reason and is
   * the only exit signal, so it always runs the engine's endSession
   * extraction — hard-capped at 1.5s because omp gives shutdown handlers a
   * ~2s concurrent budget (pi waited unbounded). Session switches flushed the
   * old session's turns via flushOnSwitch() (see above), so the journal here
   * only holds the final session's messages.
   */
  async shutdown(ctx: ExtensionContext): Promise<void> {
    const log = this.logger;
    try {
      if (ctx.hasUI) ctx.ui.setStatus("harnmem", undefined);
    } catch {
      // ignore
    }

    if (this.sessionId) {
      await this.flushJournal(this.sessionId, "quit", SHUTDOWN_EXTRACT_TIMEOUT_MS);
    }

    try {
      if (this.eng) await this.eng.close();
    } catch (err) {
      log?.warn("engine.close.error", { error: (err as Error).message });
    }
    log?.info("session.shutdown", { reason: "quit", child: this.isChild, readOnly: this.readOnly });
    await log?.flush();
  }
}

function asRecord(data: unknown): Record<string, unknown> | undefined {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  if (data === undefined) return undefined;
  return { data };
}
