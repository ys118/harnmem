/**
 * Deterministic truncation for the hook injection payload.
 *
 * Cursor does not document a size limit for `additional_context`, so the
 * adapter picks a conservative one and makes the truncation reproducible: the
 * same snapshot always truncates to the same bytes (line-aligned, never
 * splitting a UTF-8 sequence) and ends with a fixed marker so the model knows
 * the index was clipped.
 */

export const MAX_INJECT_BYTES = 10_000; // conservative cap; Cursor documents none

export const TRUNCATION_MARKER =
  "\n<!-- harnmem: snapshot truncated to fit the 10,000-character injection cap -->";

/** Truncate `text` to at most `maxBytes` UTF-8 bytes, line-aligned. */
export function capBytes(text, maxBytes = MAX_INJECT_BYTES) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  if (maxBytes <= Buffer.byteLength(TRUNCATION_MARKER, "utf8")) {
    // No useful prefix plus marker fits: injecting nothing is better than
    // injecting a payload that still exceeds the caller's budget.
    return "";
  }
  const budget = maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const out = [];
  let used = 0;
  for (const line of text.split("\n")) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > budget) break;
    out.push(line);
    used += cost;
  }
  return out.join("\n") + TRUNCATION_MARKER;
}
