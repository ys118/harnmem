/**
 * Prompt/data asset loading + first-run deployment.
 *
 * Assets are plain files so users can edit them:
 *   <home>/prompts/*.md    extraction / consolidation prompts
 *   <home>/data/*.txt      tokenizer synonym tables
 *
 * Shipped defaults live at the repository (or package) root next to `packages/`,
 * found by walking up from this module. When that root is unavailable (e.g. a
 * bundled single-file build) callers fall back to the constants in extract.ts.
 *
 * Prompt file contract (see prompts/README.md): HTML comments are metadata and
 * stripped at load time; a prompt file may contain `## system` and `## user`
 * sections. Placeholders `{{name}}` are only allowed in the user section so the
 * system prompt stays byte-stable for KV-cache reuse.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
let assetRootCache;
/** Repository/package root that contains `prompts/extract.md`, if discoverable. */
export function findAssetRoot() {
    // An explicit override is honored live on every call: a long-lived process
    // (or test harness) may repoint HARNMEM_ASSETS_DIR at runtime. Only the
    // implicit directory walk below is worth caching.
    const env = process.env.HARNMEM_ASSETS_DIR;
    if (env)
        return resolve(env);
    if (assetRootCache !== undefined)
        return assetRootCache;
    const candidates = [];
    try {
        let dir = dirname(fileURLToPath(import.meta.url));
        for (let i = 0; i < 8; i += 1) {
            candidates.push(dir);
            const parent = dirname(dir);
            if (parent === dir)
                break;
            dir = parent;
        }
    }
    catch {
        // import.meta.url is always available in ESM; ignore exotic loaders.
    }
    for (const candidate of candidates) {
        if (existsSync(join(candidate, "prompts", "extract.md"))) {
            assetRootCache = candidate;
            return candidate;
        }
    }
    assetRootCache = null;
    return null;
}
/** Read an asset, preferring the user's copy in <home>, then the shipped default. */
export function readAssetRaw(home, relativePath) {
    const candidates = [join(home, relativePath)];
    const root = findAssetRoot();
    if (root)
        candidates.push(join(root, relativePath));
    for (const file of candidates) {
        try {
            const text = readFileSync(file, "utf8");
            if (text.trim())
                return { text, source: file };
        }
        catch {
            // try next candidate
        }
    }
    return null;
}
/**
 * Language-tagged synonym tables: `synonyms.zh.txt`, `synonyms.en.txt`, ...;
 * a bare `synonyms.txt` is accepted too.
 */
const SYNONYM_FILE_RE = /^synonyms(?:\.[a-z0-9_-]+)?\.txt$/i;
/**
 * Synonym tables available to the engine: shipped defaults plus the user's
 * editable copies, deduplicated by filename and sorted for deterministic
 * loading. A language is added by adding `data/synonyms.<lang>.txt` — no code
 * change; the `<home>` copy of a filename overrides the shipped default of the
 * same name.
 */
export function listSynonymFiles(home) {
    const names = new Set();
    const collect = (root) => {
        if (!root)
            return;
        try {
            for (const file of readdirSync(join(root, "data"))) {
                if (SYNONYM_FILE_RE.test(file))
                    names.add(file);
            }
        }
        catch {
            // optional directory
        }
    };
    collect(home);
    collect(findAssetRoot());
    return [...names].sort();
}
/**
 * Parse one synonym table. Shipped format is `canonical<TAB>syn1,syn2`;
 * `=`, `:` and full-width `：` are accepted as separators too, and synonyms may
 * be separated by `,`, `，` or `、`. Blank lines and `#` comments are ignored.
 */
export function parseSynonymTable(raw) {
    const groups = [];
    for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const match = /^([^\t=:：]+)[\t=:：]+(.+)$/.exec(trimmed);
        if (!match)
            continue;
        const head = match[1];
        const tail = match[2];
        const group = [head, ...tail.split(/[,，、]/)].map((s) => s.trim()).filter(Boolean);
        if (group.length >= 2)
            groups.push(group);
    }
    return groups;
}
/** All synonym groups from every discovered table; `files` is for diagnostics. */
export function loadSynonymGroups(home) {
    const files = listSynonymFiles(home);
    const groups = [];
    for (const file of files) {
        const asset = readAssetRaw(home, join("data", file));
        if (asset)
            groups.push(...parseSynonymTable(asset.text));
    }
    return { groups, files };
}
/** Split a prompt file into stable system text + user template. */
export function parsePromptAsset(name, raw, source = "(inline)") {
    const header = /<!--\s*version:\s*(\d+)\s*-->/i.exec(raw);
    const version = header ? Number(header[1]) : 1;
    const stripped = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/\r\n/g, "\n");
    const lines = stripped.split("\n");
    const sections = {
        system: [],
        user: [],
        current: "system",
    };
    const markers = [];
    lines.forEach((line, index) => {
        const match = /^\s*##\s+(system|user)\s*$/.exec(line);
        if (match) {
            markers.push({ at: index, kind: match[1] });
        }
    });
    let system;
    let user = null;
    if (markers.length === 0) {
        // Legacy custom prompt: whole file is the system prompt.
        system = stripped.trim();
    }
    else {
        const first = markers[0];
        const body = lines.slice(0, first.at).join("\n").trim();
        if (body)
            sections.system.push(body);
        for (let i = 0; i < markers.length; i += 1) {
            const marker = markers[i];
            const next = markers[i + 1];
            const chunk = lines.slice(marker.at + 1, next ? next.at : lines.length).join("\n").trim();
            if (marker.kind === "system")
                sections.system.push(chunk);
            else
                sections.user.push(chunk);
        }
        system = sections.system.filter(Boolean).join("\n\n").trim();
        user = sections.user.filter(Boolean).join("\n\n").trim() || null;
    }
    return { name, version, system, user, source };
}
/** Load a prompt asset from <home>/prompts or the shipped defaults. */
export function loadPromptAsset(home, name) {
    const found = readAssetRaw(home, join("prompts", `${name}.md`));
    if (!found)
        return null;
    return parsePromptAsset(name, found.text, found.source);
}
/** Replace `{{name}}` placeholders. Unknown placeholders are left in place on purpose. */
export function fillPrompt(template, vars) {
    let out = template;
    for (const [key, value] of Object.entries(vars)) {
        out = out.split(`{{${key}}}`).join(value);
    }
    return out;
}
/**
 * Copy shipped defaults into <home>/ the first time they are needed. Existing
 * user files are never overwritten. Returns copied paths (home-relative).
 */
export function deployDefaultAssets(home) {
    const root = findAssetRoot();
    if (!root)
        return { copied: [], root: null };
    const copied = [];
    const copyTree = (relDir, filter) => {
        const fromDir = join(root, relDir);
        if (!existsSync(fromDir))
            return;
        const toDir = join(home, relDir);
        mkdirSync(toDir, { recursive: true });
        for (const file of readdirSync(fromDir)) {
            if (!filter(file))
                continue;
            const from = join(fromDir, file);
            const to = join(toDir, file);
            if (existsSync(to))
                continue;
            try {
                readFileSync(from); // existence/readability check
                copyFileSync(from, to);
                copied.push(join(relDir, file).replace(/\\/g, "/"));
            }
            catch {
                // deployment is best-effort
            }
        }
    };
    copyTree("prompts", (file) => file.endsWith(".md") || file.endsWith(".txt"));
    copyTree("data", (file) => file.endsWith(".txt") || file.endsWith(".tsv"));
    return { copied, root };
}
//# sourceMappingURL=assets.js.map