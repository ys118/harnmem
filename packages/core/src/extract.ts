/**
 * Post-session extraction: one bounded LLM call that turns a session digest
 * into structured memories.
 *
 * Prompt assets are data on disk: `<home>/prompts/extract.md` (user-editable)
 * overrides the shipped `prompts/extract.md`, which overrides the inline default.
 * See `assets.ts` for the file contract and `prompts/README.md` for the format.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { HarnMemConfig, LlmFn, LlmRequest, MemoryType, TranscriptMessage } from "./types.js";
import { fillPrompt, loadPromptAsset, deployDefaultAssets, type PromptAsset } from "./assets.js";
import { readTextIfExists, resolveHome } from "./util.js";

export interface ExtractedMemory {
  title: string;
  description: string;
  content: string;
  type: MemoryType;
  scope?: "user" | "project";
  category?: string;
  tags?: string[];
  entities?: string[];
  importance?: number;
  confidence?: number;
  links?: string[];
  supersedes?: string[];
  evidence?: string[];
}

export interface ExistingMemoryRef {
  id: string;
  title: string;
  type: string;
  description: string;
}

export interface ExtractionInput {
  messages: TranscriptMessage[];
  existing: ExistingMemoryRef[];
  projectName?: string;
  date: string;
}

export const DEFAULT_EXTRACT_PROMPT = `You extract durable memory from a coding-assistant session transcript.
Return JSON only: {"memories": [ {"title": string, "description": string (one sentence, <=160 chars), "content": string (markdown, 3-12 lines), "type": "user"|"feedback"|"project"|"reference", "scope": "user"|"project", "category": string, "tags": string[], "entities": string[], "importance": number (0-10), "confidence": number (0-1), "links": string[] (existing memory ids only)} ]}

Rules:
1. Only durable, reusable knowledge: user identity/preferences/workflow constraints (type user), corrections and lessons that change future behavior (type feedback; always include **Why:** and **How to apply:** lines in content), project architecture/decisions/conventions/facts (type project), external pointers/URLs/docs (type reference).
2. Do NOT store: transient task state, code that is in the repo, facts already covered by AGENTS.md/project docs, secrets, or anything the user did not state or confirm.
3. Same language as the user's conversation (Chinese stays Chinese).
4. Every entry needs an Observation Date from the transcript; put it as the first line of content: "Observed: YYYY-MM-DD".
5. Avoid duplicating existing memories (see list). If related, link by id instead of restating.
6. Exhaustive extraction: cover every distinct durable fact in the digest; do not stop after the first topic. Max 6 entries.
7. If nothing is durable, return {"memories": []}.
8. Never invent ids, versions, numbers or dates.`;

export const DEFAULT_CONSOLIDATE_PROMPT = `You consolidate a personal memory store into a topical digest.
Return JSON only: {"digest": {"title": string, "content": string (markdown, <=40 lines), "sources": string[] (memory ids)}}
Merge overlapping facts, resolve contradictions in favor of the newest observation, drop stale details, keep concrete numbers and dates. Do not invent facts.`;

/**
 * Resolve a prompt asset: user copy in <home>/prompts first, shipped default
 * second, inline constant last. Returns the parsed asset so callers can use the
 * stable system text and fill the user template with data.
 */
export function resolvePrompt(home: string, name: string, fallbackSystem: string): PromptAsset {
  const asset = loadPromptAsset(home, name);
  if (asset && asset.system.trim()) return asset;
  return { name, version: 0, system: fallbackSystem, user: null, source: "(built-in)" };
}

/** Build the bounded transcript digest sent to the extraction model. */
export function buildDigest(messages: TranscriptMessage[], maxChars = 6000): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as TranscriptMessage;
    const prefix = message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "Tool";
    const text = (message.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line = `${prefix}: ${text.slice(0, 1200)}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/** Existing-memory list for dedupe context: `[id] (type) title — description`. */
export function buildExistingList(existing: ExistingMemoryRef[], max = 60): string {
  return existing
    .slice(0, max)
    .map((m) => `- [${m.id}] (${m.type}) ${m.title} — ${m.description}`)
    .join("\n");
}

/** Parse the JSON payload from a (possibly chatty) model response. */
export function parseExtractionResponse(text: string): ExtractedMemory[] {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  const memories = (parsed as { memories?: unknown }).memories;
  if (!Array.isArray(memories)) return [];
  const types: MemoryType[] = ["user", "feedback", "project", "reference"];
  const out: ExtractedMemory[] = [];
  for (const raw of memories) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!title || !content) continue;
    const typeRaw = typeof item.type === "string" ? item.type : "project";
    const type = (types as string[]).includes(typeRaw) ? (typeRaw as MemoryType) : "project";
    const scopeRaw = typeof item.scope === "string" ? item.scope : type === "user" ? "user" : "project";
    out.push({
      title: title.slice(0, 200),
      description: typeof item.description === "string" ? item.description.slice(0, 200) : title.slice(0, 200),
      content: content.slice(0, 8000),
      type,
      scope: scopeRaw === "user" ? "user" : "project",
      category: typeof item.category === "string" ? item.category : undefined,
      tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string").slice(0, 12) : [],
      entities: Array.isArray(item.entities) ? item.entities.filter((t): t is string => typeof t === "string").slice(0, 12) : [],
      importance: typeof item.importance === "number" ? Math.max(0, Math.min(10, item.importance)) : 5,
      confidence: typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0.7,
      links: Array.isArray(item.links) ? item.links.filter((t): t is string => typeof t === "string").slice(0, 8) : [],
      supersedes: Array.isArray(item.supersedes)
        ? item.supersedes.filter((t): t is string => typeof t === "string" && /^mem_[0-9A-Z]{26}$/i.test(t)).slice(0, 8)
        : [],
      evidence: Array.isArray(item.evidence) ? item.evidence.filter((t): t is string => typeof t === "string").slice(0, 3) : [],
    });
  }
  return out;
}

/** One bounded extraction call. Returns [] when the LLM is absent or output is unusable. */
export async function runExtraction(
  llm: LlmFn | undefined,
  config: HarnMemConfig,
  input: ExtractionInput,
): Promise<ExtractedMemory[]> {
  if (!llm) return [];
  const digest = buildDigest(input.messages);
  if (digest.length < (config.write?.minDigestChars ?? 500)) return [];
  const home = config.home ?? resolveHome();
  const asset = resolvePrompt(home, "extract", DEFAULT_EXTRACT_PROMPT);
  const existingList = buildExistingList(input.existing) || "(none)";
  const legacyUserPrompt = [
    `Project: ${input.projectName ?? "(unknown)"}`,
    `Session date: ${input.date}`,
    "",
    "Existing memories (link ids, do not duplicate):",
    existingList,
    "",
    "Transcript digest:",
    digest,
  ].join("\n");
  const userPrompt = asset.user
    ? fillPrompt(asset.user, {
        observation_date: input.date,
        existing_memories: existingList,
        transcript: digest,
      })
    : legacyUserPrompt;
  const request: LlmRequest = {
    system: asset.system,
    prompt: userPrompt,
    temperature: 0,
    maxTokens: 2000,
  };
  try {
    const response = await llm(request);
    return parseExtractionResponse(response.text).slice(0, config.write?.maxPerRun ?? 6);
  } catch {
    return [];
  }
}

/** Read a session journal file back into messages (adapter-free harnesses). */
export async function readSessionJournal(file: string): Promise<TranscriptMessage[]> {
  const raw = await readTextIfExists(file);
  if (!raw) return [];
  const out: TranscriptMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { role?: string; text?: string; ts?: number };
      if (parsed.role && parsed.text) out.push({ role: parsed.role as TranscriptMessage["role"], text: parsed.text, ts: parsed.ts });
    } catch {
      // tolerate truncated journal lines
    }
  }
  return out;
}

export async function ensurePromptFiles(home: string): Promise<void> {
  await fs.mkdir(join(home, "prompts"), { recursive: true });
  // Copy shipped prompt/data defaults on first run so users have editable copies.
  deployDefaultAssets(home);
}
