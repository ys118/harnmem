/**
 * omp-harnmem: long-term memory for oh-my-pi (omp).
 *
 * Wiring (see docs/design/07-adapter-contract.md §4, adapted to omp):
 *   session_start          open the engine, build the byte-stable hot index
 *                          (omp's event has no reason field; "resume" is
 *                          inferred from existing conversational entries)
 *   before_agent_start     append that snapshot as a trailing system-prompt
 *                          segment (memory-only, so the provider prefix cache
 *                          stays warm between turns)
 *   message_end            journal messages for session-end extraction
 *   session_before_switch  flush the outgoing session's journal before omp
 *                          swaps session files
 *   session_switch         re-open session state under the new session id
 *   session_before_branch  flush the journal before omp cuts/forks the branch
 *   session_branch         re-prime the snapshot for the rewound history
 *   session_before_compact rebuild the snapshot (compaction changes history)
 *   session_shutdown       bounded (1.5s) session-end extraction — omp gives
 *                          shutdown handlers a ~2s concurrent budget
 *
 * The factory does no I/O and registers everything synchronously; omp runs
 * factories even for commands that never start a session.
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { registerCommand } from "./command.js";
import { sha256 } from "./context.js";
import { resolveSettings } from "./config.js";
import { Adapter } from "./state.js";
import { registerTools } from "./tools.js";

export default function harnmemExtension(pi: ExtensionAPI): void {
  // Tool names are fixed at registration time, so resolve the (sync, file-based)
  // config here; session_start later re-resolves with the session cwd.
  // `toolPrefix` lets HarnMem coexist with other extensions that already
  // register the default `memory_*` names: set it to "harnmem_".
  const toolPrefix = resolveSettings(process.cwd()).toolPrefix;
  const adapter = new Adapter();
  registerTools(pi, adapter, toolPrefix);
  registerCommand(pi, adapter);

  pi.on("session_start", async (_event, ctx) => {
    try {
      await adapter.start(ctx, inferStartReason(ctx));
    } catch (err) {
      // Never break omp startup because memory failed.
      adapter.logger?.error("session_start.crash", { error: (err as Error).message });
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const snapshot = adapter.snapshot;
    if (!adapter.enabled || !adapter.settings?.inject || !snapshot) return;
    const startedAt = process.hrtime.bigint();
    try {
      // omp 18.14.1 runtime: event.systemPrompt is a plain string and the
      // override only applies when the handler returns it as a string
      // (array-valued returns are silently dropped despite the string[] type).
      const base = systemPromptBase(event.systemPrompt);
      const text = await snapshot.textFor(base, "session_start");
      const elapsedUs = Number((process.hrtime.bigint() - startedAt) / 1000n);
      if (text.changed) {
        // e2e byte-stability: two turns in one session must log the same sha.
        adapter.logger?.debug("context.inject", {
          sha: sha256(text.systemPrompt),
          snapshotSha: text.snapshot?.sha ?? null,
          chars: text.systemPrompt.length,
          rebuilt: text.rebuilt,
          elapsedUs,
        });
        // omp type/runtime divergence (18.14.1): the published result type is
        // `{ systemPrompt?: string[] }`, but the runtime applies the override
        // only when it receives a plain string — arrays are silently dropped.
        // Cast is required; verified end-to-end via before_provider_request.
        return { systemPrompt: text.systemPrompt } as unknown as { systemPrompt?: string[] };
      }
    } catch (err) {
      adapter.logger?.warn("context.inject.error", { error: (err as Error).message });
    }
    return undefined;
  });

  pi.on("message_end", (event) => {
    try {
      adapter.journal.add(event.message);
    } catch {
      // Journaling is best-effort; never break the turn.
    }
  });

  // omp replaces the whole session file on /new //resume //fork. Flush the
  // outgoing session's turns while they still carry its id; do not cancel.
  pi.on("session_before_switch", async () => {
    try {
      await adapter.flushOnSwitch();
    } catch {
      // Never block a user-initiated session switch on memory extraction.
    }
  });

  pi.on("session_switch", async (event, ctx) => {
    try {
      await adapter.start(ctx, event.reason);
    } catch (err) {
      adapter.logger?.error("session_switch.crash", { error: (err as Error).message });
    }
  });

  // Branch/fork/btw cut the current transcript: capture what is about to be
  // dropped, then rebuild state for the post-cut history.
  pi.on("session_before_branch", async () => {
    try {
      await adapter.flushOnSwitch();
    } catch {
      // Never block a user-initiated branch on memory extraction.
    }
  });

  pi.on("session_branch", async (event, ctx) => {
    try {
      await adapter.start(ctx, event.reason === "branch" ? "new" : "fork");
    } catch (err) {
      adapter.logger?.error("session_branch.crash", { error: (err as Error).message });
    }
  });

  pi.on("session_before_compact", async () => {
    try {
      await adapter.refresh("compaction");
    } catch {
      // refresh() already swallows errors
    }
  });

  // Debug-only payload assertion: proves the snapshot really reaches the
  // provider request (and gives the per-turn system-prompt sha used by e2e).
  // Read-only: omp's cache-warming replay requires byte-identical payloads,
  // so this handler must never mutate the payload.
  pi.on("before_provider_request", (event) => {
    const snap = adapter.snapshot?.current;
    if (!snap || !adapter.logger || !adapter.settings?.debug) return;
    try {
      const system = findSystemText(event.payload);
      const blockText = snap.block.text;
      // Empty block must not claim success: "" is contained in every string.
      const injected =
        blockText.length > 0 && system.length > 0 ? system.includes(blockText) : null;
      adapter.logger.debug("provider.request", {
        snapshotSha: snap.sha,
        injected,
        payloadSystemSha: system ? sha256(system) : null,
        payloadSystemChars: system.length,
      });
    } catch {
      // diagnostics only
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await adapter.shutdown(ctx);
    } catch {
      // omp waits for shutdown handlers under a ~2s budget; never throw here.
    }
  });
}

export type { ExtensionAPI };

/**
 * omp's runtime `BeforeAgentStartEvent.systemPrompt` is a plain string; the
 * published type says `string[]`, so tolerate arrays and absence alike by
 * reducing whatever arrives to one string.
 */
function systemPromptBase(systemPrompt: unknown): string {
  if (typeof systemPrompt === "string") return systemPrompt;
  if (Array.isArray(systemPrompt)) {
    return systemPrompt.filter((segment): segment is string => typeof segment === "string").join("\n\n");
  }
  return "";
}

/**
 * omp's `session_start` event carries no reason (verified against 18.14.1:
 * the payload is exactly {"type":"session_start"}). Infer "resume" the same
 * way omp itself distinguishes fresh vs resumed sessions: existing
 * conversational entries mean this session file was loaded from disk.
 */
function inferStartReason(ctx: ExtensionContext): "new" | "resume" {
  try {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const hasHistory = entries.some((entry) => {
      const e = entry as { type?: unknown; message?: { role?: unknown } } | null;
      return e?.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant");
    });
    return hasHistory ? "resume" : "new";
  } catch {
    return "new";
  }
}

/** Best-effort extraction of the system prompt from provider-specific payloads. */
function findSystemText(payload: unknown): string {
  const p = payload as Record<string, unknown> | null | undefined;
  if (!p) return "";
  for (const key of ["system", "system_prompt", "systemPrompt", "instructions"]) {
    const value = p[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const joined = value
        .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
        .join("");
      if (joined) return joined;
    }
  }
  const messages = Array.isArray(p.messages) ? p.messages : [];
  for (const message of messages.slice(0, 2)) {
    const m = message as { role?: unknown; content?: unknown } | null;
    if (!m || (m.role !== "system" && m.role !== "developer")) continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
        .join("");
    }
  }
  return "";
}
