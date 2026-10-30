/**
 * OpenAI-compatible LLM bridge owned by the adapter (design/07: the engine never
 * performs network I/O; when extraction needs a model, the adapter injects it as
 * ``config.llm``).
 *
 * Configuration sources, in order:
 *   1. an explicit ``llm`` object in the bridge payload (written by the Hermes
 *      plugin from ``memory.harnmem.llm_*``),
 *   2. ``HARNMEM_LLM_URL`` / ``HARNMEM_LLM_MODEL`` / ``HARNMEM_LLM_API_KEY``
 *      (``HARNMEM_LLM_TIMEOUT_MS`` optional) — the same variables the
 *      ``harnmem synonyms`` command documents.
 *
 * An incomplete configuration returns ``null`` so ``sessionEnd()`` reports
 * ``no_llm`` instead of failing.
 */

const DEFAULT_MAX_TOKENS = 1500;
const DEFAULT_TIMEOUT_MS = 120_000;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function endpointOf(base) {
  return `${base.replace(/\/+$/, "").replace(/\/chat\/completions$/, "")}/chat/completions`;
}

/**
 * @param {{url?: unknown, model?: unknown, apiKey?: unknown, timeoutMs?: unknown}} [options]
 * @returns {null | ((request: {system: string, prompt: string, maxTokens?: number, temperature?: number}) => Promise<{text: string, promptTokens?: number, completionTokens?: number}>)}
 */
export function createLlm(options = {}) {
  const base = nonEmpty(options.url) ? options.url.trim() : "";
  const model = nonEmpty(options.model) ? options.model.trim() : "";
  if (!base || !model) return null;
  const apiKey = nonEmpty(options.apiKey) ? options.apiKey.trim() : "";
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const endpoint = endpointOf(base);

  return async function llm(request) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        temperature: request.temperature ?? 0,
        max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`LLM endpoint ${endpoint} returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`LLM endpoint ${endpoint} returned non-JSON: ${body.slice(0, 200)}`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
        : "";
    if (!text.trim()) throw new Error(`LLM endpoint ${endpoint} returned an empty completion`);
    return {
      text,
      promptTokens: Number(payload?.usage?.prompt_tokens) || undefined,
      completionTokens: Number(payload?.usage?.completion_tokens) || undefined,
    };
  };
}

/** Build the LLM callback from the documented ``HARNMEM_LLM_*`` environment. */
export function createLlmFromEnv(env = process.env) {
  return createLlm({
    url: env.HARNMEM_LLM_URL,
    model: env.HARNMEM_LLM_MODEL,
    apiKey: env.HARNMEM_LLM_API_KEY,
    timeoutMs: env.HARNMEM_LLM_TIMEOUT_MS,
  });
}
