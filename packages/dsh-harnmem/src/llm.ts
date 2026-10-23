/**
 * LLM bridge: adapts the host's `llm` service to the core's zero-network
 * `LlmFn` (types.ts:345-359). The engine never touches the network; extraction
 * degrades to `{status:"no_llm"}` when no provider/model is available.
 *
 * The host's `@deepseek-ai/dsh-llm` helpers (`createUserMessage`,
 * `BlockAssembler`) are deliberately NOT imported: a linked/development copy of
 * this plugin resolves bare specifiers from its own directory, where the
 * host-internal package is unavailable (observed in a real DSH session:
 * `Cannot find package '@deepseek-ai/dsh-llm' imported from ...dist/llm.js`,
 * which the engine reported as `status:"done", added:0`). The wire shapes are
 * small and stable — one frozen user message and a chunk stream — so this
 * module reproduces them locally while tolerating future chunk types.
 */

import { randomUUID } from "node:crypto";
import type { LlmFn, LlmRequest } from "@harnmem/core";
import type { HostAgent, HostContext } from "./host.js";
import type { Logger } from "./log.js";
import { errorMessage } from "./snapshot.js";

interface LlmStreamService {
  stream(request: unknown): AsyncIterable<unknown>;
}

export interface LlmHandle {
  fn: LlmFn;
  /** Human-readable provider/model label for logs. */
  label: string;
}

function isLlmStreamService(value: unknown): value is LlmStreamService {
  return typeof value === "object" && value !== null && typeof (value as { stream?: unknown }).stream === "function";
}

function labelOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const id = record["id"];
    if (typeof id === "string") return id;
  }
  return "?";
}

/** Structural user message accepted by the host's `llm` service. */
function userMessage(text: string): unknown {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "dsh-harnmem" },
  };
}

interface FinishReason {
  kind: string;
}

function describeFailure(failure: unknown): string {
  if (typeof failure !== "object" || failure === null) return String(failure);
  const record = failure as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["code", "message", "status"]) {
    const value = record[key];
    if (value !== undefined && value !== null) parts.push(`${key}=${String(value)}`);
  }
  return parts.length > 0 ? parts.join(" ") : JSON.stringify(failure).slice(0, 300);
}

/** Minimal chunk assembler: collect assistant text and the terminal reason. */
class TextAssembler {
  private text = "";
  private reasoningChars = 0;
  private finishReason: FinishReason | undefined;
  private failureDetail: unknown;

  push(chunk: unknown): void {
    if (typeof chunk !== "object" || chunk === null) return;
    const record = chunk as Record<string, unknown>;
    switch (record["type"]) {
      case "text-delta": {
        const delta = record["text"];
        if (typeof delta === "string") this.text += delta;
        return;
      }
      case "reasoning-delta": {
        const delta = record["text"];
        if (typeof delta === "string") this.reasoningChars += delta.length;
        return;
      }
      case "finish": {
        const reason = record["reason"];
        if (typeof reason === "object" && reason !== null) {
          const kind = (reason as Record<string, unknown>)["kind"];
          this.finishReason = { kind: typeof kind === "string" ? kind : "unknown" };
          this.failureDetail = (reason as Record<string, unknown>)["failure"];
        }
        return;
      }
      // block-start/block-end/tool-call-delta/usage carry no assistant prose we
      // need for extraction; unknown future types are ignored.
      default:
        return;
    }
  }

  get finish(): FinishReason | undefined {
    return this.finishReason;
  }

  get failure(): unknown {
    return this.failureDetail;
  }

  get reasoning(): number {
    return this.reasoningChars;
  }

  blocks(): Array<{ type: string; text?: string }> {
    return this.text.length > 0 ? [{ type: "text", text: this.text }] : [];
  }
}

/**
 * Build the engine's LlmFn, or null when the session has no usable
 * provider/model (core then skips extraction with `no_llm`).
 */
export function createLlm(ctx: HostContext, agent: HostAgent, log: Logger): LlmHandle | null {
  let service: unknown;
  try {
    service = ctx.get("llm");
  } catch {
    service = undefined;
  }
  const provider = agent.options?.provider;
  const model = agent.options?.model;
  if (!isLlmStreamService(service)) {
    log.debug("llm.unavailable", { reason: "no llm service" });
    return null;
  }
  if (provider === undefined || provider === null || model === undefined || model === null) {
    log.debug("llm.unavailable", { reason: "no provider/model on agent options" });
    return null;
  }
  const streamService = service;
  const label = `${labelOf(provider)}/${labelOf(model)}`;

  interface Attempt {
    text: string;
    finishKind: string | undefined;
    failure: unknown;
    reasoningChars: number;
  }

  // Extraction output is small but reasoning models can burn the whole token
  // budget on hidden reasoning, yielding an empty text block (observed:
  // maxTokens 2000 -> finish end + 0 text after 12.6 s). Keep a floor so the
  // JSON payload always has room once reasoning finishes.
  // Extraction output is small but reasoning models can burn the whole token
  // budget on hidden reasoning, yielding an empty text block (observed:
  // maxTokens 2000 -> finish end + 0 text after 12.6 s). Keep a floor so the
  // JSON payload always has room once reasoning finishes.
  const attempt = async (effort: string | undefined, req: LlmRequest): Promise<Attempt> => {
    const request = {
      provider,
      model,
      messages: [userMessage(`${req.system}\n\n${req.prompt}`)],
      maxTokens: Math.max(req.maxTokens ?? 2048, 4096),
      sessionId: agent.session.id,
      signal: req.signal,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    };
    const assembler = new TextAssembler();
    for await (const chunk of streamService.stream(request)) assembler.push(chunk);
    const text = assembler
      .blocks()
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n");
    return {
      text,
      finishKind: assembler.finish?.kind,
      failure: assembler.failure,
      reasoningChars: assembler.reasoning,
    };
  };

  const failureCode = (failure: unknown): string | undefined => {
    if (typeof failure !== "object" || failure === null) return undefined;
    const code = (failure as Record<string, unknown>)["code"];
    return typeof code === "string" ? code : undefined;
  };

  const call = async (req: LlmRequest): Promise<{ text: string }> => {
    log.debug("llm.call", {
      label,
      systemChars: req.system.length,
      promptChars: req.prompt.length,
      maxTokens: Math.max(req.maxTokens ?? 2048, 4096),
    });
    // Auxiliary extraction is latency-bound (it races session teardown) and
    // does not need the interactive reasoning budget: ask for no reasoning
    // first, then the lowest explicit efforts, then the model default. Providers
    // signal unsupported efforts with finish kind "error" + UNSUPPORTED_REASONING_EFFORT.
    let result: Attempt | undefined;
    for (const effort of ["none", "minimal", "low", undefined] as const) {
      result = await attempt(effort, req);
      if (result.finishKind === "error" && failureCode(result.failure) === "UNSUPPORTED_REASONING_EFFORT") {
        log.debug("llm.reasoningUnsupported", { label, effort: effort ?? "default" });
        continue;
      }
      break;
    }
    const outcome = result ?? (await attempt(undefined, req));
    log.debug("llm.response", {
      label,
      chars: outcome.text.length,
      reasoningChars: outcome.reasoningChars,
      finish: outcome.finishKind ?? null,
      preview: outcome.text.slice(0, 400),
    });
    if (outcome.finishKind === "error") {
      throw new Error(`harnmem: llm call failed (${label}): ${describeFailure(outcome.failure)}`);
    }
    if (outcome.finishKind === "aborted") {
      throw req.signal?.reason ?? new Error(`harnmem: llm call aborted (${label})`);
    }
    if (!outcome.text.trim()) throw new Error(`harnmem: empty llm response (${label})`);
    return { text: outcome.text };
  };

  const fn: LlmFn = async (req: LlmRequest) => {
    try {
      return await call(req);
    } catch (err) {
      // Core's runExtraction swallows LLM failures (returns []), which is how
      // `status:"done", added:0` hid a broken aux call. Surface it in dsh.jsonl.
      log.error("llm.callFailed", { label, error: errorMessage(err) });
      throw err;
    }
  };

  return { fn, label };
}

export function llmError(error: unknown): string {
  return errorMessage(error);
}
