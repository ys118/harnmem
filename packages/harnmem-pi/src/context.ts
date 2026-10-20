/**
 * Byte-stable hot-index snapshot ("Option P").
 *
 * pi awaits `before_agent_start` on every turn, so the steady-state path must
 * be pure memory: no disk I/O, no timestamps, no counters. We rebuild only on
 * the events the engine declares as snapshot-invalidating:
 *
 *   session_start / resume / compaction / memory_write / day_rollover / manual
 *
 * Everything else returns the exact same string, which keeps the provider
 * prefix cache (system prompt block) warm across turns.
 */

import { createHash } from "node:crypto";
import type { ContextBlock, ContextReason, HarnMem } from "@harnmem/core";
import type { Logger } from "./log.js";

export interface Snapshot {
  block: ContextBlock;
  /** sha256 of block.text, logged for e2e byte-stability assertions. */
  sha: string;
  /** Local calendar day the snapshot was built (YYYY-MM-DD). */
  day: string;
  builtAt: number;
}

export interface SnapshotText {
  systemPrompt: string;
  snapshot: Snapshot | null;
  rebuilt: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function localDayKey(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class SnapshotManager {
  private snap: Snapshot | null = null;
  private dirty = true;
  private dirtyReason: ContextReason = "session_start";
  private inflight: Promise<Snapshot | null> | null = null;

  constructor(
    private readonly engine: () => HarnMem | null,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): Snapshot | null {
    return this.snap;
  }

  /** Mark the snapshot stale; the next before_agent_start rebuilds it. */
  markDirty(reason: ContextReason): void {
    this.dirty = true;
    this.dirtyReason = reason;
    this.log.debug("snapshot.dirty", { reason });
  }

  /**
   * Adopt an engine block that was already built (session_start) so the first
   * turn pays no extra disk read. `builtAt` is deliberately not embedded in
   * the injected text, only used for status/logging.
   */
  prime(block: ContextBlock, reason: ContextReason): Snapshot {
    const now = this.now();
    const snapshot: Snapshot = { block, sha: sha256(block.text), day: localDayKey(now), builtAt: now };
    this.snap = snapshot;
    this.dirty = false;
    this.dirtyReason = reason;
    return snapshot;
  }

  /** Refresh only when dirty / missing / crossed a local day boundary. */
  async ensureFresh(reason: ContextReason): Promise<Snapshot | null> {
    const eng = this.engine();
    if (!eng) return null;
    const now = this.now();
    const day = localDayKey(now);
    if (!this.dirty && this.snap && this.snap.day === day) return this.snap;
    if (this.inflight) return this.inflight;

    const effectiveReason: ContextReason =
      this.snap && this.snap.day !== day ? "day_rollover" : this.dirty ? this.dirtyReason : reason;
    this.inflight = (async (): Promise<Snapshot | null> => {
      const startedAt = Date.now();
      try {
        const block = await eng.ensureContext(effectiveReason);
        const snapshot: Snapshot = { block, sha: sha256(block.text), day, builtAt: Date.now() };
        this.snap = snapshot;
        this.dirty = false;
        this.log.debug("snapshot.built", {
          reason: effectiveReason,
          sha: snapshot.sha,
          bytes: Buffer.byteLength(block.text, "utf8"),
          tokensEstimate: block.tokensEstimate,
          ids: block.ids.length,
          elapsedMs: Date.now() - startedAt,
        });
        return snapshot;
      } catch (err) {
        this.log.warn("snapshot.failed", { reason: effectiveReason, error: (err as Error).message });
        // Keep serving the previous snapshot (if any) rather than breaking turns.
        return this.snap;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Force a rebuild (e.g. compaction) but never throw. */
  async rebuild(reason: ContextReason): Promise<Snapshot | null> {
    this.dirty = true;
    return this.ensureFresh(reason);
  }

  /** The per-turn entry point: returns the system prompt with the stable block appended. */
  async textFor(systemPrompt: string, reason: ContextReason): Promise<SnapshotText> {
    const before = this.snap;
    const snap = await this.ensureFresh(reason);
    if (!snap || !snap.block.text) return { systemPrompt, snapshot: snap, rebuilt: snap !== before };
    return {
      systemPrompt: systemPrompt + "\n\n" + snap.block.text,
      snapshot: snap,
      rebuilt: snap !== before,
    };
  }

  describe(): string {
    if (!this.snap) return "no snapshot";
    return `${this.snap.block.ids.length} entries · ~${this.snap.block.tokensEstimate} tokens · ${this.snap.sha.slice(0, 8)}`;
  }
}

export { DAY_MS };
