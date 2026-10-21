/**
 * pi-harnmem: long-term memory for the pi coding agent.
 *
 * Wiring (see docs/design/07-adapter-contract.md §4):
 *   session_start        open the engine, build the byte-stable hot index
 *   before_agent_start   append that snapshot to the system prompt (memory-only,
 *                        so the provider prefix cache stays warm between turns)
 *   message_end          journal messages for session-end extraction
 *   session_before_compact  rebuild the snapshot (compaction changes history)
 *   session_shutdown     only on quit: bounded (8s) session-end extraction
 *
 * The factory does no I/O and registers everything synchronously; pi runs
 * factories even for commands that never start a session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommand } from "./command.js";
import { sha256 } from "./context.js";
import { resolveSettings } from "./config.js";
import { Adapter } from "./state.js";
import { registerTools } from "./tools.js";

export default function harnmemExtension(pi: ExtensionAPI): void {
  // Tool names are fixed at registration time, so resolve the (sync, file-based)
  // config here; session_start later re-resolves with the session cwd.
  // `toolPrefix` lets HarnMem coexist with extensions that already register the
  // default `memory_*` names (for example pi-memory): set it to "harnmem_".
  const toolPrefix = resolveSettings(process.cwd()).toolPrefix;
  const adapter = new Adapter();
  registerTools(pi, adapter, toolPrefix);
  registerCommand(pi, adapter);

  pi.on("session_start", async (event, ctx) => {
    try {
      await adapter.start(ctx, event.reason);
    } catch (err) {
      // Never break pi startup because memory failed.
      adapter.logger?.error("session_start.crash", { error: (err as Error).message });
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const snapshot = adapter.snapshot;
    if (!adapter.enabled || !adapter.settings?.inject || !snapshot) return;
    const startedAt = process.hrtime.bigint();
    try {
      const text = await snapshot.textFor(event.systemPrompt, "session_start");
      const elapsedUs = Number((process.hrtime.bigint() - startedAt) / 1000n);
      if (text.systemPrompt !== event.systemPrompt) {
        // e2e byte-stability: two turns in one session must log the same sha.
        adapter.logger?.debug("context.inject", {
          sha: sha256(text.systemPrompt),
          snapshotSha: text.snapshot?.sha ?? null,
          chars: text.systemPrompt.length,
          rebuilt: text.rebuilt,
          elapsedUs,
        });
        return { systemPrompt: text.systemPrompt };
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

  pi.on("session_before_compact", async () => {
    try {
      await adapter.refresh("compaction");
    } catch {
      // refresh() already swallows errors
    }
  });

  // Debug-only payload assertion: proves the snapshot really reaches the
  // provider request (and gives the per-turn system-prompt sha used by e2e).
  pi.on("before_provider_request", (event) => {
    const snap = adapter.snapshot?.current;
    if (!snap || !adapter.logger || !adapter.settings?.debug) return;
    try {
      const system = findSystemText(event.payload);
      adapter.logger.debug("provider.request", {
        snapshotSha: snap.sha,
        injected: snap.block.text.length > 0 ? system.includes(snap.block.text) : true,
        payloadSystemSha: system ? sha256(system) : null,
        payloadSystemChars: system.length,
      });
    } catch {
      // diagnostics only
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    try {
      await adapter.shutdown(ctx, event.reason);
    } catch {
      // pi waits for shutdown handlers without a timeout; never throw here.
    }
  });
}

export type { ExtensionAPI };

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
