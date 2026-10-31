/**
 * LLM bridge: adapts omp's provider stack to the engine's zero-network `LlmFn`.
 *
 * Uses `ctx.modelRegistry.getApiKeyAndHeaders()` for request-time auth and
 * `completeSimple()` from @oh-my-pi/pi-ai (omp's host-rewritten copy of the
 * pi-ai one-shot API; the loader maps this specifier onto the bundled module,
 * so the import must stay a literal). The engine only ever sees a plain
 * text-in/text-out function; extraction failures degrade to
 * `{status:"failed"}` and never break the session.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Api, Context, Effort, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { completeSimple } from "@oh-my-pi/pi-ai";
import type { LlmFn, LlmRequest, LlmResponse } from "@harnmem/core";
import type { OmpHarnMemSettings, ReasoningEffort } from "./config.js";
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

function asEffort(effort: ReasoningEffort | undefined): Effort | undefined {
  if (!effort) return undefined;
  // Both unions share low/medium/high; omp's Effort is a string-valued const
  // enum (minimal..max), so the shared members are runtime-identical.
  return effort as unknown as Effort;
}

export function resolveModel(ctx: ExtensionContext, settings: OmpHarnMemSettings): Model<Api> | undefined {
  const configured = settings.model;
  if (configured?.provider && configured?.id) {
    const found = ctx.modelRegistry.find(configured.provider, configured.id);
    if (found) return found as Model<Api>;
  }
  if (ctx.model) return ctx.model as Model<Api>;
  return undefined;
}

export function createLlm(ctx: ExtensionContext, settings: OmpHarnMemSettings, log: Logger): LlmHandle | null {
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
    // omp's SimpleStreamOptions carries no timeoutMs and no env: the timeout
    // is enforced through the abort signal alone, and env-key auth is the
    // registry's job.
    const signal = req.signal ?? AbortSignal.timeout(defaultTimeout);
    const options: SimpleStreamOptions = {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      reasoning: asEffort(req.reasoningEffort ?? settings.model?.reasoning),
      signal,
      sessionId: ctx.sessionManager.getSessionId(),
    };
    const startedAt = Date.now();
    try {
      const context: Context = {
        systemPrompt: req.system ? [req.system] : undefined,
        messages: [{ role: "user", content: req.prompt, timestamp: Date.now() }],
      };
      const response = await completeSimple(modelUnknown as never, context, options);
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
