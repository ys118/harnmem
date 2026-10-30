/**
 * Offline synonym-table suggestions.
 *
 * The shipped tables are deliberately generic; every user's own corpus has
 * vocabulary that a generic dictionary cannot know (jargon, product names,
 * team slang). This module turns a local memory corpus into a bounded,
 * validated list of synonym groups that a human reviews and then adds to
 * `<home>/data/synonyms.<lang>.txt`.
 *
 * The engine never performs network I/O: `suggestSynonyms` takes an `LlmFn`
 * (the same contract extraction uses), so the CLI can bridge to any
 * OpenAI-compatible endpoint while adapters reuse their host model.
 *
 * Why the model, not statistics: the pairs worth adding (降级 ↔ 兜底,
 * 灰度 ↔ 分批发布) share no characters, so co-occurrence mining cannot discover
 * them. Precision is the risk, so the output is a proposal list — never an
 * automatic edit — and every group is validated against the corpus first.
 */
import { fillPrompt, loadSynonymGroups } from "./assets.js";
import { resolvePrompt } from "./extract.js";
/** Inline fallback used when `prompts/synonyms.md` is missing. */
export const DEFAULT_SUGGEST_PROMPT = `You maintain the synonym table of a personal memory store. The store is searched with BM25; Chinese text is tokenized into character bigrams, so two different phrasings of the same idea often share no characters. Your job: propose synonym groups that connect such phrasings.

You receive: the language, frequent terms found in the user's memories, up to a few dozen sample memories, and the existing synonym table.

Return JSON only:
{"groups":[{"canonical":"<term>","synonyms":["<term>","<term>"]}]}

Rules:
1. Every term must occur in the samples or the candidate terms. Never invent vocabulary.
2. A group means the entries are interchangeable for searching: a query using one should find memories that use another. Rewrites with no shared characters are the most valuable (e.g. 降级 -> 兜底, 灰度 -> 分批发布).
3. Do not propose synonyms that merely share a character or a substring, are grammatical variants of the same word, or are generic hypernyms. Ranking words (best, top, latest) and UI labels are not synonyms.
4. 2-5 terms per group; canonical is the term most likely used in a search query.
5. Skip anything already covered by the existing table.
6. Do not propose words that are frequent in this user's domain but mean different things (homonyms across domains).
7. If nothing is worth adding, return {"groups":[]}.
8. Use the language of the memories for the terms. Output no markdown, no explanation.`;
const DEFAULT_SUGGEST_USER = `Language: {{language}}

Frequent terms (term (count); most frequent first):
{{terms}}

Existing synonym table (canonical = synonym, synonym):
{{existing}}

Sample memories:
{{samples}}`;
const MAX_TERM_CHARS = 24;
const MAX_SYNONYMS = 4;
const CORPUS_CHARS = 500_000;
const MAX_PROMPT_TERMS = 120;
/** Chinese function words: never useful as a canonical term. */
const STOP_ZH = new Set([
    "我们", "你们", "他们", "她们", "它们", "这个", "那个", "这些", "那些", "什么", "怎么",
    "可以", "需要", "应该", "可能", "已经", "还是", "就是", "没有", "不是", "不能", "一个",
    "一些", "自己", "现在", "时候", "问题", "东西", "这样", "那样", "之后", "之前", "的话",
    "以及", "但是", "因为", "所以", "如果", "虽然", "然后", "而且", "或者", "并且", "通过",
    "使用", "进行", "非常", "比较", "一直", "起来", "出来", "下来", "上去", "一下", "其实",
    "目前", "主要", "相关", "内容", "情况", "方法", "方式", "部分", "地方", "时候",
]);
/** English function words (lowercase). */
const STOP_EN = new Set([
    "the", "and", "for", "with", "this", "that", "from", "have", "will", "would", "should",
    "could", "about", "into", "than", "then", "when", "what", "which", "where", "while",
    "also", "just", "only", "more", "most", "some", "very", "can", "may", "not", "but",
    "our", "your", "its", "all", "any", "how", "why", "who", "use", "used", "using", "new",
    "old", "get", "got", "make", "made", "need", "needs", "want", "like", "one", "two",
    "been", "were", "are", "was", "has", "had", "does", "did", "there", "their", "them",
]);
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const ASCII_WORD = /[A-Za-z][A-Za-z0-9+#._-]{1,}/g;
/** Trim noise from a model-supplied term without changing its core. */
export function cleanTerm(raw) {
    if (typeof raw !== "string")
        return "";
    return raw
        .normalize("NFKC")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[\s"'`([{<]+/, "")
        .replace(/^[-*•·–—]+\s*/, "")
        .replace(/[\s"'`)\]}>.,;:!?，。；：！？、]+$/, "")
        .trim();
}
function isStopWord(term) {
    if (STOP_ZH.has(term))
        return true;
    return STOP_EN.has(term.toLowerCase());
}
function isAscii(term) {
    return /^[\x20-\x7e]+$/.test(term);
}
/** Normalize a harvested term; "" means "not a usable term". */
function normalizeHarvest(raw) {
    const term = cleanTerm(raw);
    if (term.length < 2 || term.length > MAX_TERM_CHARS)
        return "";
    if (isAscii(term)) {
        const lower = term.toLowerCase();
        if (!/^[a-z][a-z0-9+#._-]*$/.test(lower))
            return "";
        if (lower.length < 3)
            return "";
        return lower;
    }
    return term;
}
/**
 * Frequency pass over the corpus. Then output is guidance for the model, not
 * a decision: the validator accepts canonicals that appear anywhere in the
 * corpus, so a sparse harvest can never veto a good proposal.
 */
export function harvestTerms(records = [], messages = [], opts = {}) {
    const minSupport = Math.max(1, Math.floor(opts.minSupport ?? 2));
    const maxTerms = Math.max(1, Math.floor(opts.maxTerms ?? MAX_PROMPT_TERMS));
    const counts = new Map();
    const add = (term, weight, seen) => {
        if (!term || isStopWord(term) || seen.has(term))
            return;
        seen.add(term);
        const current = counts.get(term) ?? { support: 0, score: 0 };
        current.support += 1;
        current.score += weight;
        counts.set(term, current);
    };
    for (const record of records) {
        const seen = new Set();
        for (const tag of record.tags ?? [])
            add(normalizeHarvest(tag), 3, seen);
        for (const entity of record.entities ?? [])
            add(normalizeHarvest(entity), 2, seen);
        for (const text of [record.title ?? "", record.description ?? ""]) {
            for (const run of text.match(CJK_RUN) ?? [])
                add(normalizeHarvest(run), 1, seen);
            for (const word of text.match(ASCII_WORD) ?? [])
                add(normalizeHarvest(word), 1, seen);
        }
    }
    for (const message of messages) {
        const seen = new Set();
        for (const word of (message.text ?? "").match(ASCII_WORD) ?? [])
            add(normalizeHarvest(word), 1, seen);
    }
    return [...counts.entries()]
        .filter(([, value]) => value.support >= minSupport)
        .map(([term, value]) => ({ term, support: value.support, score: value.score }))
        .sort((a, b) => b.support - a.support || b.score - a.score || (a.term < b.term ? -1 : 1))
        .slice(0, maxTerms);
}
/** Lowercased text used both for prompting and for validating canonicals. */
export function buildSuggestCorpus(records = [], messages = []) {
    const parts = [];
    for (const record of records) {
        if (record.title)
            parts.push(record.title);
        if (record.description)
            parts.push(record.description);
        if (record.content)
            parts.push(record.content);
        if (record.tags?.length)
            parts.push(record.tags.join(" "));
        if (record.entities?.length)
            parts.push(record.entities.join(" "));
    }
    for (const message of messages)
        if (message.text)
            parts.push(message.text);
    return parts.join("\n").normalize("NFKC").toLowerCase().slice(0, CORPUS_CHARS);
}
function buildSamples(records, messages, maxSamples, sampleChars) {
    const lines = [];
    for (const record of records.slice(0, maxSamples)) {
        const title = (record.title ?? "").replace(/\s+/g, " ").trim();
        const description = (record.description ?? "").replace(/\s+/g, " ").trim();
        if (!title && !description)
            continue;
        const line = description ? `${title} — ${description}` : title;
        lines.push(`- ${line.slice(0, sampleChars)}`);
        if (lines.length >= maxSamples)
            break;
    }
    for (const message of messages.slice(0, 8)) {
        const text = (message.text ?? "").replace(/\s+/g, " ").trim();
        if (!text)
            continue;
        lines.push(`- [session] ${text.slice(0, Math.min(sampleChars, 140))}`);
    }
    return lines.join("\n") || "(empty)";
}
/**
 * Build the prompt from the shipped (or user-edited) `prompts/synonyms.md`
 * asset. The system section stays byte-stable; only the user section is
 * filled, matching the asset contract in `prompts/README.md`.
 */
export function buildSuggestPrompt(home, options) {
    const asset = resolvePrompt(home, "synonyms", DEFAULT_SUGGEST_PROMPT);
    let terms = harvestTerms(options.records, options.messages, {
        minSupport: options.minSupport,
        maxTerms: options.maxTerms,
    });
    // A tiny or very diverse corpus has no term seen twice; showing nothing would
    // starve the model, so relax the support threshold instead of sending "(none)".
    if (terms.length === 0) {
        terms = harvestTerms(options.records, options.messages, { minSupport: 1, maxTerms: options.maxTerms });
    }
    const existing = options.existing ?? loadSynonymGroups(home).groups;
    const termsText = terms.length
        ? terms.map((term) => `${term.term} (${term.support})`).join(", ")
        : "(none)";
    const existingText = existing.length
        ? existing.slice(0, 40).map((group) => `${group[0]} = ${group.slice(1).join(", ")}`).join("\n")
        : "(empty)";
    const samples = buildSamples(options.records ?? [], options.messages ?? [], options.maxSamples ?? 16, options.sampleChars ?? 160);
    const template = asset.user && asset.user.trim() ? asset.user : DEFAULT_SUGGEST_USER;
    const user = fillPrompt(template, {
        language: options.language ?? "zh",
        terms: termsText,
        existing: existingText,
        samples,
    });
    return { system: asset.system.trim(), user, source: asset.source, terms, hasTemplate: Boolean(asset.user && asset.user.trim()) };
}
/** Tolerant JSON extraction: models like to wrap JSON in prose or fences. */
export function parseSuggestionGroups(text) {
    const raw = typeof text === "string" ? text : "";
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start)
        return { groups: [], invalid: 1 };
    let parsed;
    try {
        parsed = JSON.parse(raw.slice(start, end + 1));
    }
    catch {
        return { groups: [], invalid: 1 };
    }
    const candidates = parsed?.groups;
    if (!Array.isArray(candidates))
        return { groups: [], invalid: 1 };
    const groups = [];
    let invalid = 0;
    for (const item of candidates) {
        const record = item;
        const canonical = typeof record?.canonical === "string" ? cleanTerm(record.canonical) : "";
        const synonyms = Array.isArray(record?.synonyms)
            ? record.synonyms.filter((value) => typeof value === "string").map(cleanTerm).filter(Boolean)
            : [];
        if (!canonical || synonyms.length === 0) {
            invalid += 1;
            continue;
        }
        groups.push({ canonical, synonyms });
    }
    return { groups, invalid };
}
/**
 * Validate model proposals against the corpus and the tables already in force.
 * Anything unverifiable is rejected with a reason instead of being written.
 */
export function validateSuggestions(groups, opts) {
    const maxGroups = Math.max(1, Math.floor(opts.maxGroups ?? 24));
    const corpus = (opts.corpus ?? "").toLowerCase();
    const terms = new Set((opts.terms ?? []).map((term) => term.term.toLowerCase()));
    const existing = (opts.existing ?? []).map((group) => group.map(cleanTerm).filter(Boolean));
    const existingCanonicals = new Set(existing.map((group) => (group[0] ?? "").toLowerCase()).filter(Boolean));
    const existingSets = existing.filter((group) => group.length >= 2).map((group) => new Set(group.map((term) => term.toLowerCase())));
    const seenCanonicals = new Set();
    const proposals = [];
    const rejected = [];
    for (const group of groups) {
        const canonical = cleanTerm(group.canonical ?? "");
        const proposed = (group.synonyms ?? []).map(cleanTerm).filter(Boolean);
        const reject = (reason) => {
            rejected.push({ canonical: group.canonical ?? "", synonyms: group.synonyms ?? [], reason });
        };
        if (!canonical || canonical.length < 2 || canonical.length > MAX_TERM_CHARS) {
            reject("canonical is empty or out of bounds");
            continue;
        }
        const key = canonical.toLowerCase();
        if (isStopWord(canonical)) {
            reject("canonical is a function word");
            continue;
        }
        if (!corpus.includes(key) && !terms.has(key)) {
            reject("canonical does not occur in the corpus");
            continue;
        }
        if (existingCanonicals.has(key)) {
            reject("canonical is already in the tables in force");
            continue;
        }
        if (seenCanonicals.has(key)) {
            reject("duplicate canonical in the model output");
            continue;
        }
        const kept = [];
        let problem = "";
        for (const synonym of proposed) {
            if (synonym.length < 2 || synonym.length > MAX_TERM_CHARS) {
                problem = `synonym "${synonym}" is out of bounds`;
                break;
            }
            const synKey = synonym.toLowerCase();
            if (synKey === key)
                continue;
            if (isStopWord(synonym))
                continue;
            if (synKey.includes(key) || key.includes(synKey)) {
                problem = `synonym "${synonym}" is a substring of the canonical`;
                break;
            }
            if (kept.some((term) => term.toLowerCase() === synKey))
                continue;
            kept.push(synonym);
            if (kept.length >= MAX_SYNONYMS)
                break;
        }
        if (problem) {
            reject(problem);
            continue;
        }
        if (kept.length === 0) {
            reject("no usable synonyms after filtering");
            continue;
        }
        if (proposals.length >= maxGroups) {
            reject("group limit reached");
            continue;
        }
        const set = new Set([key, ...kept.map((term) => term.toLowerCase())]);
        if (existingSets.some((existingSet) => [...set].every((term) => existingSet.has(term)))) {
            reject("already covered by the tables in force");
            continue;
        }
        seenCanonicals.add(key);
        proposals.push({ canonical, synonyms: kept });
    }
    return { proposals, rejected };
}
function prepare(home, options) {
    const records = options.records ?? [];
    const messages = options.messages ?? [];
    if (records.length === 0 && messages.length === 0) {
        throw new Error("synonym suggestion needs a corpus: no memory records or session messages were found");
    }
    const existing = options.existing ?? loadSynonymGroups(home).groups;
    const prompt = buildSuggestPrompt(home, { ...options, existing });
    const corpus = buildSuggestCorpus(records, messages);
    return { prompt, corpus, existing, terms: prompt.terms };
}
/** Validate a model response that was produced elsewhere (offline workflow). */
export function suggestFromResponse(home, options, response) {
    const { prompt, corpus, existing, terms } = prepare(home, options);
    const parsed = parseSuggestionGroups(response);
    const { proposals, rejected } = validateSuggestions(parsed.groups, {
        terms,
        corpus,
        existing,
        maxGroups: options.maxGroups,
    });
    return { proposals, rejected, prompt, parsedGroups: parsed.groups.length };
}
/** Run the whole suggestion pass with a caller-supplied model bridge. */
export async function suggestSynonyms(home, options) {
    if (typeof options.llm !== "function")
        throw new Error("suggestSynonyms requires an llm bridge");
    const { prompt, corpus, existing, terms } = prepare(home, options);
    const response = await options.llm({
        system: prompt.system,
        prompt: prompt.user,
        temperature: 0,
        maxTokens: 1500,
    });
    const parsed = parseSuggestionGroups(response?.text ?? "");
    const { proposals, rejected } = validateSuggestions(parsed.groups, {
        terms,
        corpus,
        existing,
        maxGroups: options.maxGroups,
    });
    return { proposals, rejected, prompt, parsedGroups: parsed.groups.length };
}
//# sourceMappingURL=suggest.js.map