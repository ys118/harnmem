/**
 * Small utilities shared by the engine. No runtime dependencies.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** ULID-like 26-char Crockford base32 id, time-sortable. */
export function newMemoryId(now = Date.now()) {
    let ts = Math.floor(now);
    let time = "";
    for (let i = 0; i < 10; i++) {
        time = CROCKFORD[ts % 32] + time;
        ts = Math.floor(ts / 32);
    }
    let rand = "";
    const bytes = randomBytes(10);
    for (const b of bytes)
        rand += CROCKFORD[b % 32];
    return `mem_${time}${rand}`;
}
export function sha256Hex(input) {
    return createHash("sha256").update(input).digest("hex");
}
export function sha1Hex(input) {
    return createHash("sha1").update(input).digest("hex");
}
/** FNV-1a 64-bit as bigint (used for simhash feature hashing). */
export function fnv1a64(input) {
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = (1n << 64n) - 1n;
    for (let i = 0; i < input.length; i++) {
        h ^= BigInt(input.charCodeAt(i));
        h = (h * prime) & mask;
    }
    return h;
}
/** 64-bit SimHash over weighted tokens (weights: Map token -> weight). */
export function simhash64(weights) {
    const bits = new Array(64).fill(0);
    for (const [token, weight] of weights) {
        let h = fnv1a64(token);
        for (let i = 0; i < 64; i++) {
            const bit = Number(h & 1n);
            bits[i] = (bits[i] ?? 0) + (bit ? weight : -weight);
            h >>= 1n;
        }
    }
    let out = 0n;
    for (let i = 63; i >= 0; i--)
        out = (out << 1n) | ((bits[i] ?? 0) > 0 ? 1n : 0n);
    return out;
}
export function hamming64(a, b) {
    let x = a ^ b;
    let count = 0;
    while (x) {
        count += Number(x & 1n);
        x >>= 1n;
    }
    return count;
}
export function simhashHex(value) {
    return value.toString(16).padStart(16, "0");
}
export function parseSimhashHex(hex) {
    if (!hex || typeof hex !== "string")
        return null;
    try {
        return BigInt(`0x${hex}`);
    }
    catch {
        return null;
    }
}
/** Jaccard similarity of two string sets (or arrays). */
export function jaccard(a, b) {
    const sa = a instanceof Set ? a : new Set(a);
    const sb = b instanceof Set ? b : new Set(b);
    if (sa.size === 0 && sb.size === 0)
        return 1;
    let inter = 0;
    for (const x of sa)
        if (sb.has(x))
            inter++;
    const union = sa.size + sb.size - inter;
    return union === 0 ? 0 : inter / union;
}
/** Character n-grams (default 3) for CJK-friendly fuzzy comparison. */
export function charNgrams(text, n = 3) {
    const s = normalizeForCompare(text).replace(/\s+/g, " ");
    const out = new Set();
    if (s.length <= n) {
        if (s)
            out.add(s);
        return out;
    }
    for (let i = 0; i <= s.length - n; i++)
        out.add(s.slice(i, i + n));
    return out;
}
export function normalizeForCompare(text) {
    return text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[*_`#>~-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
export function normalizeNewlines(text) {
    return text.replace(/\r\n?/g, "\n");
}
/** Estimate tokens for mixed CJK/English text (chars/2.8 is conservative for zh). */
export function estimateTokens(text) {
    if (!text)
        return 0;
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (code >= 0x2e80 && code <= 0x9fff)
            cjk++;
        else
            other++;
    }
    return Math.ceil(cjk / 1.7 + other / 4.2);
}
export async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}
export async function atomicWriteFile(file, data) {
    await ensureDir(dirname(file));
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, file);
}
export async function readJson(file, fallback) {
    try {
        const raw = await fs.readFile(file, "utf8");
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
export async function writeJson(file, value) {
    await atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
export async function pathExists(path) {
    try {
        await fs.access(path);
        return true;
    }
    catch {
        return false;
    }
}
export async function readTextIfExists(file) {
    try {
        return await fs.readFile(file, "utf8");
    }
    catch {
        return null;
    }
}
export function expandHome(input) {
    if (input === "~")
        return homedir();
    if (input.startsWith("~/") || input.startsWith("~\\"))
        return join(homedir(), input.slice(2));
    return input;
}
export function resolveHome(input) {
    if (input && input.trim())
        return resolve(expandHome(input.trim()));
    const env = process.env.HARNMEM_HOME;
    if (env && env.trim())
        return resolve(expandHome(env.trim()));
    return join(homedir(), ".harnmem");
}
export function truncateText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
/** Deterministic date key in local time, e.g. 2026-10-20. */
export function dayKey(ts = Date.now()) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = `${d.getMonth() + 1}`.padStart(2, "0");
    const day = `${d.getDate()}`.padStart(2, "0");
    return `${y}-${m}-${day}`;
}
export function parseTimestamp(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim()) {
        if (/^\d+$/.test(value.trim()))
            return Number(value.trim());
        const ts = Date.parse(value);
        if (Number.isFinite(ts))
            return ts;
    }
    return fallback;
}
/** "2026-10-20" / ISO string -> end-of-day timestamp for as-of queries. */
export function parseAsOf(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
            const ts = Date.parse(`${trimmed}T23:59:59.999Z`);
            if (Number.isFinite(ts))
                return ts;
        }
        const ts = Date.parse(trimmed);
        if (Number.isFinite(ts))
            return ts;
    }
    return fallback;
}
export function clamp(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, value));
}
export function sortedUnique(values) {
    return [...new Set([...values].filter(Boolean))].sort();
}
export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export function withTimeout(promise, ms, label = "operation") {
    return new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        promise.then((v) => {
            clearTimeout(timer);
            resolvePromise(v);
        }, (e) => {
            clearTimeout(timer);
            reject(e);
        });
    });
}
//# sourceMappingURL=util.js.map