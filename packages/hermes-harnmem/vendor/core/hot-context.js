/**
 * Synchronous hot-index reader for cold starts.
 *
 * Harnesses assemble the prompt before the adapter's async session bootstrap
 * has finished, so a snapshot built from the engine can still be empty on the
 * very first turn. This module renders the same injected block directly from
 * the persisted index files with `node:fs` synchronous calls, which makes
 * injection available immediately after process start. It is a read-only
 * fallback: the async engine path stays authoritative once ready.
 *
 * The layout itself is shared with `Retriever.buildContext` through
 * `layoutHotContext`, so both paths produce byte-identical blocks.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { budgetOf, retrievalOf } from "./config.js";
import { parseFrontmatter } from "./frontmatter.js";
import { normalizePathKey } from "./project.js";
import { layoutHotContext, renderContextText } from "./retrieval.js";
const indexCache = new Map();
function readJsonSync(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}
function statSignature(path) {
    try {
        const stat = statSync(path);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
    }
    catch {
        return null;
    }
}
/** Read one persisted shard index, cached by (mtime, size). */
function readShardDocs(file) {
    const signature = statSignature(file);
    if (!signature)
        return [];
    const cached = indexCache.get(file);
    if (cached && cached.mtimeMs === signature.mtimeMs && cached.size === signature.size)
        return cached.docs;
    try {
        const parsed = readJsonSync(file);
        if (!parsed || !Array.isArray(parsed.docs))
            return [];
        const docs = parsed.docs.filter((doc) => {
            if (typeof doc !== "object" || doc === null)
                return false;
            const candidate = doc;
            return typeof candidate.id === "string" && typeof candidate.title === "string" && typeof candidate.status === "string";
        });
        indexCache.set(file, { ...signature, docs });
        return docs;
    }
    catch {
        return [];
    }
}
/** Resolve the project id whose recorded path best contains `cwd`. */
function resolveProjectId(home, cwd) {
    if (!cwd)
        return null;
    const registries = (() => {
        try {
            const parsed = readJsonSync(join(home, "projects.json"));
            if (!parsed || typeof parsed !== "object" || !parsed.projects)
                return null;
            return { version: 1, projects: parsed.projects };
        }
        catch {
            return null;
        }
    })();
    if (!registries)
        return null;
    const target = normalizePathKey(cwd);
    // A registry can hold several ids for the same path (a `path:` entry and a
    // `git:` entry written by different runs). Keep every candidate and prefer
    // the one that actually has memories: returning the first match would
    // silently drop that project's shard from the injected block.
    const candidates = new Map();
    for (const entry of Object.values(registries.projects)) {
        if (!entry || typeof entry.id !== "string" || !Array.isArray(entry.paths))
            continue;
        for (const path of entry.paths) {
            if (typeof path !== "string")
                continue;
            const normalized = normalizePathKey(path);
            if (target !== normalized && !target.startsWith(`${normalized}/`))
                continue;
            const known = candidates.get(entry.id) ?? -1;
            if (normalized.length > known)
                candidates.set(entry.id, normalized.length);
        }
    }
    if (candidates.size === 0)
        return null;
    if (candidates.size === 1)
        return candidates.keys().next().value ?? null;
    let best = null;
    for (const [id, length] of candidates) {
        const records = projectRecordCount(home, id);
        if (!best || records > best.records || (records === best.records && length > best.length)) {
            best = { id, length, records };
        }
    }
    return best?.id ?? null;
}
/** Number of memory files in a project shard (`-1` when the shard is missing). */
function projectRecordCount(home, projectId) {
    try {
        return readdirSync(join(home, "memories", "projects", projectId)).filter((file) => file.endsWith(".md") && file !== "MEMORY.md").length;
    }
    catch {
        return -1;
    }
}
/** Read digest pages for one shard without touching the async store. */
function readDigests(home, shard) {
    const dir = join(home, "digests", shard);
    let files;
    try {
        files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
    }
    catch {
        return [];
    }
    const out = [];
    for (const file of files) {
        try {
            const parsed = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
            const firstHeading = parsed.body.split("\n").find((line) => line.trim().startsWith("#"));
            out.push({
                title: firstHeading ? firstHeading.replace(/^#+\s*/, "").trim() : file.replace(/\.md$/, ""),
                body: parsed.body.trim(),
            });
        }
        catch {
            // skip unreadable digest
        }
    }
    return out;
}
/**
 * Render the injected hot-index block synchronously from disk.
 *
 * @returns the same block shape as `HarnMem.ensureContext()`, or an empty
 * `text` when the store has no active memory for the scopes in play.
 */
export function renderHotContextSync(options) {
    const home = options.home;
    const now = options.now ?? Date.now();
    const projectId = resolveProjectId(home, options.cwd);
    const shards = projectId ? ["user", projectId] : ["user"];
    const docs = [];
    for (const shard of shards) {
        docs.push(...readShardDocs(join(home, "index", `${shard}.json`)));
    }
    const digests = [];
    for (const shard of shards)
        digests.push(...readDigests(home, shard));
    const budgetConfig = budgetOf((options.config ?? {}));
    const retrieval = retrievalOf((options.config ?? {}));
    const layout = layoutHotContext(docs, digests, {
        now,
        budgetTokens: budgetConfig.injectTokens,
        maxPinned: budgetConfig.maxPinned,
        hotEntries: budgetConfig.hotEntries,
        decayPerHour: retrieval.decayPerHour,
    });
    const text = layout.hasContent ? renderContextText(layout.sections) : "";
    return {
        text,
        ids: layout.ids,
        tokensEstimate: layout.hasContent ? layout.tokensEstimate : 0,
        projectId,
        shards,
    };
}
//# sourceMappingURL=hot-context.js.map