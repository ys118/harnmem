/**
 * LLM bridge: adapts the host's `llm` service to the core's zero-network
 * `LlmFn` (types.ts:345-359). The engine never touches the network; extraction
 * degrades to `{status:"no_llm"}` when no provider/model is available.
 *
 * `@deepseek-ai/dsh-llm` is loaded dynamically: it lives inside DSH's asar and
 * is absent in tests. A missing module makes the bridge throw on first use,
 * which the engine records as a failed extraction — never a crash.
 */

import type { LlmFn, LlmRequest } from "@harnmem/core";
import type { HostAgent, HostContext } from "./host.js";
import type { Logger } from "./log.js";
import { errorMessage } from "./snapshot.js";

interface LlmStreamService {
  stream(request: unknown): AsyncIterable<unknown>;
}

interface DshLlmModule {
  BlockAssembler: new () => {
    push(chunk: unknown): void;
    blocks(): Array<{ type: string; text?: string }>;
    readonly finish: { kind: string };
  };
  createUserMessage(input: {
    content: Array<{ type: "text"; text: string }>;
    source?: unknown;
  }): unknown;
}

export interface LlmHandle {
  fn: LlmFn;
  /** Human-readable provider/model label for logs. */
  label: string;
}

function isLlmStreamService(value: unknown): value is LlmStreamService {
  return typeof value === "object" && value !== null && typeof (value as { stream?: unknown }).stream === "function";
}

let dshLlm: Promise<DshLlmModule> | null = null;

async function loadDshLlm(): Promise<DshLlmModule> {
  if (!dshLlm) {
    dshLlm = import("@deepseek-ai/dsh-llm").then((mod) => mod as unknown as DshLlmModule);
  }
  return dshLlm;
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

  const fn: LlmFn = async (req: LlmRequest) => {
    const mod = await loadDshLlm();
    const assembler = new mod.BlockAssembler();
    const messages = [
      mod.createUserMessage({
        content: [{ type: "text", text: `${req.system}\n\n${req.prompt}` }],
        source: { kind: "dsh-harnmem" },
      }),
    ];
    const iterator = streamService.stream({
      provider,
      model,
      messages,
      maxTokens: req.maxTokens ?? 2048,
      sessionId: agent.session.id,
      signal: req.signal,
    });
    for await (const chunk of iterator) assembler.push(chunk);

    const finish = assembler.finish;
    if (finish?.kind === "error") throw new Error(`harnmem: llm call failed (${label})`);
    if (finish?.kind === "aborted") {
      throw req.signal?.reason ?? new Error(`harnmem: llm call aborted (${label})`);
    }
    const text = assembler
      .blocks()
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n");
    // The success variant of finish.kind is unverified (R5): non-empty text wins.
    if (!text.trim()) throw new Error(`harnmem: empty llm response (${label})`);
    // Token accounting is not exposed by the streaming API here → omit.
    return { text };
  };

  return { fn, label };
}

export function llmError(error: unknown): string {
  return errorMessage(error);
}
