import type { HarnMemConfig, LlmFn, MemoryType, TranscriptMessage } from "./types.js";
import { type PromptAsset } from "./assets.js";
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
export declare const DEFAULT_EXTRACT_PROMPT = "You extract durable memory from a coding-assistant session transcript.\nReturn JSON only: {\"memories\": [ {\"title\": string, \"description\": string (one sentence, <=160 chars), \"content\": string (markdown, 3-12 lines), \"type\": \"user\"|\"feedback\"|\"project\"|\"reference\", \"scope\": \"user\"|\"project\", \"category\": string, \"tags\": string[], \"entities\": string[], \"importance\": number (0-10), \"confidence\": number (0-1), \"links\": string[] (existing memory ids only)} ]}\n\nRules:\n1. Only durable, reusable knowledge: user identity/preferences/workflow constraints (type user), corrections and lessons that change future behavior (type feedback; always include **Why:** and **How to apply:** lines in content), project architecture/decisions/conventions/facts (type project), external pointers/URLs/docs (type reference).\n2. Do NOT store: transient task state, code that is in the repo, facts already covered by AGENTS.md/project docs, secrets, or anything the user did not state or confirm.\n3. Same language as the user's conversation (Chinese stays Chinese).\n4. Every entry needs an Observation Date from the transcript; put it as the first line of content: \"Observed: YYYY-MM-DD\".\n5. Avoid duplicating existing memories (see list). If related, link by id instead of restating.\n6. Exhaustive extraction: cover every distinct durable fact in the digest; do not stop after the first topic. Max 6 entries.\n7. If nothing is durable, return {\"memories\": []}.\n8. Never invent ids, versions, numbers or dates.";
export declare const DEFAULT_CONSOLIDATE_PROMPT = "You consolidate a personal memory store into a topical digest.\nReturn JSON only: {\"digest\": {\"title\": string, \"content\": string (markdown, <=40 lines), \"sources\": string[] (memory ids)}}\nMerge overlapping facts, resolve contradictions in favor of the newest observation, drop stale details, keep concrete numbers and dates. Do not invent facts.";
/**
 * Resolve a prompt asset: user copy in <home>/prompts first, shipped default
 * second, inline constant last. Returns the parsed asset so callers can use the
 * stable system text and fill the user template with data.
 */
export declare function resolvePrompt(home: string, name: string, fallbackSystem: string): PromptAsset;
/** Build the bounded transcript digest sent to the extraction model. */
export declare function buildDigest(messages: TranscriptMessage[], maxChars?: number): string;
/** Existing-memory list for dedupe context: `[id] (type) title — description`. */
export declare function buildExistingList(existing: ExistingMemoryRef[], max?: number): string;
/** Parse the JSON payload from a (possibly chatty) model response. */
export declare function parseExtractionResponse(text: string): ExtractedMemory[];
/** One bounded extraction call. Returns [] when the LLM is absent or output is unusable. */
export declare function runExtraction(llm: LlmFn | undefined, config: HarnMemConfig, input: ExtractionInput): Promise<ExtractedMemory[]>;
/** Read a session journal file back into messages (adapter-free harnesses). */
export declare function readSessionJournal(file: string): Promise<TranscriptMessage[]>;
export declare function ensurePromptFiles(home: string): Promise<void>;
//# sourceMappingURL=extract.d.ts.map