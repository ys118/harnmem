/**
 * LLM bridge: adapts pi's provider stack to the engine's zero-network `LlmFn`.
 *
 * Uses `ctx.modelRegistry.getApiKeyAndHeaders()` for request-time auth and
 * `completeSimple()` from pi-ai's compat entrypoint (the stable one-shot API
 * that pi 1.3.0 extensions are documented to use). The engine only ever sees
 * a plain text-in/text-out function; extraction failures degrade to
 * `{status:"failed"}` and never break the session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ProviderHeaders, SimpleStreamOptions, ThinkingLevel } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { LlmFn, LlmRequest, LlmResponse } from "@harnmem/core";
import type { PiHarnMemSettings, ReasoningEffort } from "./config.js";
import type { Logger } from "./log.js";

export interface LlmHandle {
  fn: LlmFn;
  /** Human-readable model label for logs/status. */
  label: string;
}

function extractText(message: { content: Array<{ type: string; text?: string }> }): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("");
}

function asThinkingLevel(effort: ReasoningEffort | undefined): ThinkingLevel | undefined {
  if (!effort) return undefined;
  // Both unions share low/medium/high; pi-ai's ThinkingLevel is a superset.
  return effort as ThinkingLevel;
}

export function resolveModel(ctx: ExtensionContext, settings: PiHarnMemSettings): Model<Api> | undefined {
  const configured = settings.model;
  if (configured?.provider && configured?.id) {
    const found = ctx.modelRegistry.find(configured.provider, configured.id);
    if (found) return found as Model<Api>;
  }
  if (ctx.model) return ctx.model as Model<Api>;
  return undefined;
}

export function createLlm(ctx: ExtensionContext, settings: PiHarnMemSettings, log: Logger): LlmHandle | null {
  const model = resolveModel(ctx, settings);
  if (!model) {
    log.info("llm.unavailable", { reason: "no model in session" });
    return null;
  }
  const modelUnknown = model as Model<Api>;
  const label = `${(modelUnknown as { provider?: string }).provider ?? "?"}/${(modelUnknown as { id?: string }).id ?? "?"}`;
  const defaultTimeout = settings.model?.timeoutMs ?? 60_000;

  const fn: LlmFn = async (req: LlmRequest): Promise<LlmResponse> => {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(modelUnknown);
    if (!auth.ok) throw new Error(`harnmem: no credentials for ${label}: ${auth.error}`);
    const timeoutMs = defaultTimeout;
    const signal = req.signal ?? AbortSignal.timeout(timeoutMs);
    const options: SimpleStreamOptions = {
      apiKey: auth.apiKey,
      headers: auth.headers as ProviderHeaders | undefined,
      env: auth.env as Record<string, string> | undefined,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      reasoning: asThinkingLevel(req.reasoningEffort ?? settings.model?.reasoning),
      signal,
      timeoutMs,
      sessionId: ctx.sessionManager.getSessionId(),
    };
    const startedAt = Date.now();
    try {
      const response = await completeSimple(
        modelUnknown as never,
        { systemPrompt: req.system, messages: [{ role: "user", content: req.prompt, timestamp: Date.now() }] },
        options,
      );
      const text = extractText(response as { content: Array<{ type: string; text?: string }> });
      if (!text.trim() && (response as { stopReason?: string }).stopReason === "error") {
        throw new Error("harnmem: model returned an error with no text");
      }
      const usage = (response as { usage?: { input?: number; output?: number } }).usage;
      log.debug("llm.complete", {
        model: label,
        elapsedMs: Date.now() - startedAt,
        chars: text.length,
        promptTokens: usage?.input,
        completionTokens: usage?.output,
      });
      return { text, promptTokens: usage?.input, completionTokens: usage?.output };
    } catch (err) {
      log.warn("llm.failed", { model: label, elapsedMs: Date.now() - startedAt, error: (err as Error).message });
      throw err;
    }
  };

  return { fn, label };
}
