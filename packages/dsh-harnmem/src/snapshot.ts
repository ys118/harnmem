/**
 * Byte-stable hot-index snapshot ("Option P", 08 §4).
 *
 * The injected text must be identical across turns so the provider prefix cache
 * stays warm. This manager therefore does no I/O on the steady-state path: it
 * serves the cached `ContextBlock.text` and rebuilds only when marked dirty
 * (memory_write/compaction/manual) or when the local calendar day changed.
 * Rebuilds go through `HarnMem.ensureContext()`, which is itself deterministic.
 */

import { createHash } from "node:crypto";
import type { ContextBlock, ContextReason, HarnMem } from "@harnmem/core";
import type { Logger } from "./log.js";

/** Budget for an async rebuild on the pre-step fast path (08 §3). */
export const PRE_STEP_BUDGET_MS = 300;

export interface Snapshot {
  block: ContextBlock;
  /** sha256 of block.text; logged for byte-stability assertions. */
  sha: string;
  /** Local day the snapshot was built (YYYY-MM-DD); used for day_rollover. */
  dayKey: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function localDayKey(now: number): string {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class SnapshotManager {
  private snap: Snapshot | null = null;
  private dirty = true;
  private dirtyReason: ContextReason = "session_start";
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly engine: () => HarnMem | null,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): Snapshot | null {
    return this.snap;
  }

  /** In-memory text only — this is the callback used by the prompt section. */
  text(): string {
    return this.snap?.block.text ?? "";
  }

  markDirty(reason: ContextReason): void {
    this.dirty = true;
    this.dirtyReason = reason;
  }

  /** Adopt a block that was already built (session start) — no extra disk read. */
  prime(block: ContextBlock, reason: ContextReason): Snapshot {
    const snapshot: Snapshot = {
      block,
      sha: sha256(block.text),
      dayKey: localDayKey(this.now()),
    };
    this.snap = snapshot;
    this.dirty = false;
    this.dirtyReason = reason;
    return snapshot;
  }

  /**
   * Refresh only when dirty / missing / crossed a local day. Budgeted on the
   * pre-step path; on timeout or failure the previous snapshot keeps serving.
   */
  async ensureFresh(reason: ContextReason, budgetMs = Number.POSITIVE_INFINITY): Promise<void> {
    const engine = this.engine();
    if (!engine) return;
    const dayChanged = this.snap !== null && this.snap.dayKey !== localDayKey(this.now());
    if (!this.dirty && this.snap !== null && !dayChanged) return;
    if (this.inflight) {
      await this.inflight;
      return;
    }

    const effective: ContextReason = dayChanged ? "day_rollover" : this.dirty ? this.dirtyReason : reason;
    const work = (async (): Promise<void> => {
      const startedAt = this.now();
      try {
        const block = await engine.ensureContext(effective);
        const snapshot: Snapshot = {
          block,
          sha: sha256(block.text),
          dayKey: localDayKey(this.now()),
        };
        this.snap = snapshot;
        this.dirty = false;
        this.log.debug("snapshot.rebuilt", {
          reason: effective,
          sha: snapshot.sha,
          bytes: Buffer.byteLength(block.text, "utf8"),
          tokensEstimate: block.tokensEstimate,
          ids: block.ids.length,
          elapsedMs: this.now() - startedAt,
        });
      } catch (err) {
        // fail closed: keep the previous bytes, retry on the next trigger.
        this.log.warn("snapshot.failed", { reason: effective, error: errorMessage(err) });
      }
    })();
    this.inflight = work;
    try {
      if (Number.isFinite(budgetMs)) {
        const timeout = new Promise<"timeout">((resolve) => {
          const timer = setTimeout(() => resolve("timeout"), budgetMs);
          timer.unref?.();
        });
        const outcome = await Promise.race([work, timeout]);
        if (outcome === "timeout") {
          this.log.warn("snapshot.timeout", { reason: effective, budgetMs });
          // Keep `dirty` so the next pre-step retries; `work` keeps running in
          // the background and its result is adopted when it settles.
        }
      } else {
        await work;
      }
    } finally {
      this.inflight = null;
    }
  }

  /** Force a rebuild now (compaction, resume, manual consolidation). */
  async refresh(reason: ContextReason, budgetMs = Number.POSITIVE_INFINITY): Promise<void> {
    this.dirty = true;
    this.dirtyReason = reason;
    await this.ensureFresh(reason, budgetMs);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
