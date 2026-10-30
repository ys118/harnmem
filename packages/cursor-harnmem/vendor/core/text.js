/**
 * Text processing: CJK bigram tokenizer + weighted BM25F scoring primitives.
 * Pure JS, zero dependencies. See docs/design/03-retrieval.md.
 */
import { normalizeNewlines } from "./util.js";
const CJK_RE = /[\u4e00-\u9fff]+|[A-Za-z0-9_]+/g;
const CJK_CHAR_RE = /[\u4e00-\u9fff]/;
const STOPWORDS = new Set([
    "的",
    "了",
    "是",
    "在",
    "和",
    "中",
    "我",
    "你",
    "他",
    "她",
    "好",
    "the",
    "a",
    "an",
    "of",
    "to",
    "is",
    "are",
    "and",
    "or",
    "in",
    "on",
    "for",
    "with",
    "this",
    "that",
]);
/**
 * Tokenize text into index terms. CJK runs become character bigrams plus the
 * boundary unigrams (so single-character queries still match).
 *
 * `query: true` drops those boundary unigrams from multi-character runs: they
 * are artifacts of the bigram window (e.g. the trailing character of a longer
 * query phrase), and as query terms they matched unrelated documents through
 * one shared character (S6 abstain false positives). A genuinely
 * single-character query is kept.
 */
export function tokenize(text, opts = {}) {
    if (!text)
        return [];
    const out = [];
    const input = normalizeNewlines(text).normalize("NFKC");
    CJK_RE.lastIndex = 0;
    let m;
    while ((m = CJK_RE.exec(input))) {
        const t = m[0];
        if (CJK_CHAR_RE.test(t)) {
            if (t.length === 1) {
                if (!opts.stopwords || !STOPWORDS.has(t))
                    out.push(t);
                continue;
            }
            for (let i = 0; i < t.length - 1; i++)
                out.push(t.slice(i, i + 2));
            if (!opts.query)
                out.push(t[0], t[t.length - 1]);
        }
        else {
            const lower = t.toLowerCase();
            if (opts.stopwords && STOPWORDS.has(lower))
                continue;
            if (lower.length >= 2 || /^\d+$/.test(lower))
                out.push(lower);
        }
    }
    return out;
}
/** Token counts for a text field. */
export function termFreq(text) {
    const tf = new Map();
    for (const token of tokenize(text, { stopwords: true })) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    return tf;
}
export const DEFAULT_FIELDS = {
    title: 3.0,
    description: 2.0,
    tags: 2.5,
    entities: 2.0,
    body: 1.0,
};
/** Weighted term frequencies and weighted document length for BM25F. */
export function weightedTerms(fields, weights = DEFAULT_FIELDS) {
    const tf = new Map();
    let len = 0;
    const add = (text, weight) => {
        const counts = termFreq(text);
        let count = 0;
        for (const [term, n] of counts) {
            tf.set(term, (tf.get(term) ?? 0) + n * weight);
            count += n;
        }
        len += count * weight;
    };
    add(fields.title, weights.title);
    add(fields.description, weights.description);
    add(fields.tags.join(" "), weights.tags);
    add(fields.entities.join(" "), weights.entities);
    add(fields.body.slice(0, 8192), weights.body);
    return { tf, len };
}
export const DEFAULT_BM25 = { k1: 1.2, b: 0.75 };
export function idf(nDocs, df) {
    return Math.log(1 + (nDocs - df + 0.5) / (df + 0.5));
}
/**
 * Score a single doc for a set of unique query terms using precomputed postings.
 * `postings` maps term -> Map<docIdx, weighted tf> (built by the indexer).
 */
export function bm25fScore(queryTerms, docIdx, postings, docLens, avgLen, params = DEFAULT_BM25) {
    const nDocs = docLens.length;
    let score = 0;
    const { k1, b } = params;
    const docLen = docLens[docIdx] ?? avgLen;
    for (const term of queryTerms) {
        const posting = postings.get(term);
        if (!posting)
            continue;
        const wTf = posting.get(docIdx);
        if (!wTf)
            continue;
        const df = posting.size;
        const norm = k1 * (1 - b + (b * docLen) / (avgLen || 1));
        score += idf(nDocs, df) * ((wTf * (k1 + 1)) / (wTf + norm));
    }
    return score;
}
/** First meaningful paragraph of a markdown body, trimmed for a snippet. */
export function extractSnippet(body, maxChars = 400) {
    const lines = normalizeNewlines(body).split("\n");
    const parts = [];
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            if (parts.length > 0)
                break;
            continue;
        }
        if (trimmed.startsWith("#"))
            continue;
        if (trimmed.startsWith("---"))
            continue;
        parts.push(trimmed);
        if (parts.join(" ").length >= maxChars)
            break;
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars - 1)}…`;
}
/** Cos similarity between two token-count vectors (used by MMR). */
export function cosineTokens(a, b) {
    if (a.size === 0 || b.size === 0)
        return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (const [, v] of a)
        na += v * v;
    for (const [, v] of b)
        nb += v * v;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    for (const [k, v] of small) {
        const other = big.get(k);
        if (other)
            dot += v * other;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom === 0 ? 0 : dot / denom;
}
const CJK_RUN = /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+$/;
/**
 * Query token expansion via the built-in synonym table (zero LLM).
 *
 * Two guards keep expansion from *hurting* precision:
 *  - single-character CJK query tokens are boundary artifacts of the bigram
 *    tokenizer (for example one character of a longer word), not real
 *    concepts; they are not expanded.
 *  - a synonym phrase is re-tokenized, but single-character CJK tokens of that
 *    phrase are dropped. Without this, expanding a two-character query term
 *    injected stray characters that matched every album/note record (S6
 *    abstain false positives).
 */
export function expandQueryTerms(terms, synonyms) {
    const out = new Set(terms);
    for (const term of terms) {
        if (CJK_RUN.test(term) && term.length === 1)
            continue;
        const syns = synonyms.get(term);
        if (!syns)
            continue;
        for (const syn of syns) {
            for (const t of tokenize(syn)) {
                if (CJK_RUN.test(t) && t.length === 1)
                    continue;
                out.add(t);
            }
        }
    }
    return [...out];
}
/**
 * Parse simple Chinese/English time expressions into a [from, to] window.
 * Rules only; unknown expressions return null (caller falls back to text search).
 */
export function parseTimeExpression(query, now) {
    const text = query.trim();
    const day = 86400000;
    const startOfDay = (ts) => {
        const d = new Date(ts);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    };
    const today = startOfDay(now);
    if (/今天/.test(text))
        return { from: today, to: now };
    if (/昨天|昨日/.test(text))
        return { from: today - day, to: today - 1 };
    if (/前天/.test(text))
        return { from: today - 2 * day, to: today - day - 1 };
    if (/本周|这周|这礼拜/.test(text))
        return { from: today - 6 * day, to: now };
    if (/上周|上礼拜/.test(text))
        return { from: today - 13 * day, to: today - 7 * day };
    if (/本月|这个月/.test(text))
        return { from: today - 29 * day, to: now };
    if (/上个月|上月/.test(text))
        return { from: today - 59 * day, to: today - 30 * day };
    if (/今年/.test(text)) {
        const d = new Date(now);
        const from = new Date(d.getFullYear(), 0, 1).getTime();
        return { from, to: now };
    }
    const lastN = /最近\s*(\d+)\s*(天|日|周|个月)/.exec(text);
    if (lastN) {
        const n = Number(lastN[1]);
        const unit = lastN[2] ?? "";
        const mult = unit.includes("周") ? 7 * day : unit.includes("月") ? 30 * day : day;
        return { from: now - n * mult, to: now };
    }
    return null;
}
//# sourceMappingURL=text.js.map