import { normalizeNewlines } from "./util.js";
const FIELD_ORDER = [
    "schema",
    "id",
    "type",
    "category",
    "scope",
    "project",
    "project_name",
    "title",
    "description",
    "tags",
    "entities",
    "importance",
    "confidence",
    "pinned",
    "status",
    "created",
    "updated",
    "last_used",
    "used_count",
    "valid_from",
    "valid_to",
    "observed_at",
    "evidence",
    "source",
    "provenance",
    "links",
    "supersedes",
    "superseded_by",
    "sensitive",
    "migrated_from",
];
function splitFrontmatter(raw) {
    const text = normalizeNewlines(raw);
    if (!text.startsWith("---"))
        return { yaml: "", body: text, hadMarker: false };
    const end = text.indexOf("\n---", 3);
    if (end === -1)
        return { yaml: "", body: text, hadMarker: false };
    const yaml = text.slice(3, end).replace(/^\n/, "");
    let body = text.slice(end + 4);
    if (body.startsWith("\n"))
        body = body.slice(1);
    return { yaml, body, hadMarker: true };
}
/** Minimal YAML subset parser. */
export function parseYamlSubset(yaml) {
    const data = {};
    const errors = [];
    const lines = yaml.split("\n");
    let i = 0;
    const parseScalar = (input) => {
        const value = input.trim();
        if (value === "" || value === "null" || value === "~")
            return null;
        if (value === "true")
            return true;
        if (value === "false")
            return false;
        if (/^-?\d+(\.\d+)?$/.test(value))
            return Number(value);
        if (value.startsWith("[") && value.endsWith("]")) {
            const inner = value.slice(1, -1).trim();
            if (!inner)
                return [];
            return splitInline(inner).map((item) => parseScalar(item));
        }
        if (value.startsWith("{") && value.endsWith("}")) {
            // Nested objects (e.g. source with migratedFrom) are serialized as compact
            // JSON on a single line to keep the YAML subset parser simple. See
            // valueToYamlLines("…nested object inside nested object").
            try {
                const parsed = JSON.parse(value);
                if (parsed && typeof parsed === "object")
                    return parsed;
            }
            catch {
                // fall through: keep the raw string for malformed/legacy values
            }
        }
        if (value.startsWith('"') && value.endsWith('"')) {
            // Double-quoted values are JSON.stringify output: parse the full escape
            // set (\n, \t, \u…) exactly. Fall back to the legacy partial unescape for
            // malformed/legacy literals.
            try {
                return JSON.parse(value);
            }
            catch {
                return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
            }
        }
        if (value.startsWith("'") && value.endsWith("'")) {
            return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        }
        return value;
    };
    const splitInline = (input) => {
        const out = [];
        let cur = "";
        let quote = null;
        for (const ch of input) {
            if (quote) {
                cur += ch;
                if (ch === quote)
                    quote = null;
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                cur += ch;
                continue;
            }
            if (ch === ",") {
                out.push(cur.trim());
                cur = "";
                continue;
            }
            cur += ch;
        }
        if (cur.trim())
            out.push(cur.trim());
        return out;
    };
    while (i < lines.length) {
        const line = lines[i] ?? "";
        i++;
        if (!line.trim() || line.trimStart().startsWith("#"))
            continue;
        const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(.*)$/.exec(line);
        if (!match) {
            errors.push(`line ${i}: not a key:value line: ${line.slice(0, 120)}`);
            continue;
        }
        const key = match[1];
        const rest = (match[2] ?? "").trim();
        if (rest === "") {
            // nested map (one level) or block array
            const nested = {};
            const list = [];
            let sawList = false;
            while (i < lines.length) {
                const next = lines[i] ?? "";
                if (!/^\s+/.test(next))
                    break;
                i++;
                const trimmed = next.trim();
                if (!trimmed || trimmed.startsWith("#"))
                    continue;
                if (trimmed.startsWith("- ")) {
                    sawList = true;
                    list.push(parseScalar(trimmed.slice(2)));
                    continue;
                }
                const kv = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(.*)$/.exec(trimmed);
                if (!kv) {
                    errors.push(`line ${i}: bad nested entry: ${trimmed.slice(0, 120)}`);
                    continue;
                }
                nested[kv[1]] = parseScalar(kv[2] ?? "");
            }
            data[key] = sawList ? list : nested;
            continue;
        }
        data[key] = parseScalar(rest);
    }
    return { data, errors };
}
export function parseFrontmatter(raw) {
    const { yaml, body, hadMarker } = splitFrontmatter(raw);
    if (!hadMarker)
        return { data: {}, body, noFrontmatter: true, errors: [] };
    const { data, errors } = parseYamlSubset(yaml);
    return { data, body, noFrontmatter: false, errors };
}
function needsQuote(value) {
    if (value === "")
        return true;
    if (value.includes("\n") || value.includes("\r"))
        return true;
    if (/^[\s]|[\s]$/.test(value))
        return true;
    if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value))
        return true;
    if (value.includes(": ") || value.includes(" #"))
        return true;
    if (value === "true" || value === "false" || value === "null")
        return true;
    if (/^-?\d+(\.\d+)?$/.test(value))
        return true;
    return false;
}
function scalarToYaml(value) {
    if (value === null || value === undefined)
        return "null";
    if (typeof value === "boolean")
        return value ? "true" : "false";
    if (typeof value === "number")
        return Number.isFinite(value) ? String(value) : "null";
    if (typeof value === "string")
        return needsQuote(value) ? JSON.stringify(value) : value;
    if (Array.isArray(value))
        return `[${value.map((v) => scalarToYaml(v)).join(", ")}]`;
    return JSON.stringify(value);
}
function valueToYamlLines(key, value) {
    if (Array.isArray(value)) {
        if (value.length === 0)
            return [`${key}: []`];
        const allScalar = value.every((v) => v === null || typeof v !== "object");
        if (allScalar)
            return [`${key}: ${scalarToYaml(value)}`];
        return [`${key}:`, ...value.map((v) => `  - ${scalarToYaml(v)}`)];
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined);
        if (entries.length === 0)
            return [`${key}: {}`];
        if (entries.every(([, v]) => v === null || typeof v !== "object")) {
            return [`${key}:`, ...entries.map(([k, v]) => `  ${k}: ${scalarToYaml(v)}`)];
        }
        // nested object inside nested object: serialize compressed JSON to keep the parser simple
        return [`${key}: ${JSON.stringify(value)}`];
    }
    return [`${key}: ${scalarToYaml(value)}`];
}
/** Serialize a MemoryRecord into a markdown file with canonical frontmatter. */
export function serializeRecord(record) {
    const data = {
        schema: 1,
        id: record.id,
        type: record.type,
        category: record.category,
        scope: record.scope,
        project: record.project,
        project_name: record.projectName,
        title: record.title,
        description: record.description,
        tags: record.tags,
        entities: record.entities,
        importance: record.importance,
        confidence: record.confidence,
        pinned: record.pinned,
        status: record.status,
        created: record.created,
        updated: record.updated,
        last_used: record.lastUsed,
        used_count: record.usedCount,
        valid_from: record.validFrom,
        valid_to: record.validTo,
        observed_at: record.observedAt,
        evidence: record.evidence,
        source: record.source,
        provenance: record.provenance,
        links: record.links,
        supersedes: record.supersedes,
        superseded_by: record.supersededBy,
        sensitive: record.sensitive ?? undefined,
    };
    if (record.source?.migratedFrom)
        data["migrated_from"] = record.source.migratedFrom;
    const extra = record.extra ?? {};
    for (const [k, v] of Object.entries(extra)) {
        if (k in data)
            continue;
        data[k] = v;
    }
    const keys = [
        ...FIELD_ORDER.filter((k) => k in data && data[k] !== undefined),
        ...Object.keys(data).filter((k) => !FIELD_ORDER.includes(k)),
    ];
    const lines = ["---"];
    for (const key of keys) {
        const value = data[key];
        if (value === undefined)
            continue;
        lines.push(...valueToYamlLines(key, value));
    }
    lines.push("---", "", record.content.trimEnd(), "");
    return lines.join("\n");
}
function asString(value, fallback = "") {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "boolean")
        return String(value);
    return fallback;
}
function asNumber(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()))
        return Number(value);
    return fallback;
}
function asBoolean(value, fallback) {
    if (typeof value === "boolean")
        return value;
    if (value === "true")
        return true;
    if (value === "false")
        return false;
    return fallback;
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.map((v) => asString(v)).filter((v) => v.length > 0);
}
const TYPES = ["user", "feedback", "project", "reference"];
const STATUSES = ["active", "superseded", "archived", "dropped"];
export function recordFromFrontmatter(data, body, fallbackId, now) {
    const id = asString(data["id"], fallbackId);
    const typeRaw = asString(data["type"], "project");
    const type = TYPES.includes(typeRaw) ? typeRaw : "project";
    const scopeRaw = asString(data["scope"], "project");
    const scope = scopeRaw === "user" ? "user" : "project";
    const statusRaw = asString(data["status"], "active");
    const status = STATUSES.includes(statusRaw) ? statusRaw : "active";
    const created = asNumber(data["created"], now);
    const updated = asNumber(data["updated"], created);
    const sourceRaw = (data["source"] ?? {});
    const migrated = (data["migrated_from"] ?? sourceRaw["migrated_from"]);
    const source = {
        harness: asString(sourceRaw["harness"], "unknown"),
        session: asString(sourceRaw["session"]) || undefined,
        turn: typeof sourceRaw["turn"] === "number" ? sourceRaw["turn"] : undefined,
        ts: asNumber(sourceRaw["ts"], created),
        migratedFrom: migrated && typeof migrated === "object"
            ? {
                system: asString(migrated["system"], "unknown"),
                path: asString(migrated["path"]) || undefined,
                originalId: asString(migrated["original_id"] ?? migrated["originalId"]) || undefined,
            }
            : undefined,
    };
    const validFrom = asNumber(data["valid_from"], created);
    const validToRaw = data["valid_to"];
    const validTo = validToRaw === null || validToRaw === undefined || validToRaw === "" ? null : asNumber(validToRaw, validFrom);
    return {
        schema: 1,
        id,
        type,
        category: asString(data["category"]) || undefined,
        scope,
        project: asString(data["project"]) || undefined,
        projectName: asString(data["project_name"]) || undefined,
        title: asString(data["title"], "(untitled)"),
        description: asString(data["description"]),
        content: body.trimEnd(),
        tags: asStringArray(data["tags"]),
        entities: asStringArray(data["entities"]),
        importance: asNumber(data["importance"], 5),
        confidence: asNumber(data["confidence"], 0.8),
        pinned: asBoolean(data["pinned"], false),
        status,
        created,
        updated,
        lastUsed: data["last_used"] === undefined || data["last_used"] === null ? undefined : asNumber(data["last_used"], 0),
        usedCount: asNumber(data["used_count"], 0),
        validFrom,
        validTo,
        observedAt: data["observed_at"] === undefined ? undefined : asNumber(data["observed_at"], created),
        evidence: asNumber(data["evidence"], 0),
        source,
        provenance: asStringArray(data["provenance"]),
        links: asStringArray(data["links"]),
        supersedes: asStringArray(data["supersedes"]),
        supersededBy: asString(data["superseded_by"]) || null,
        sensitive: data["sensitive"] === undefined ? undefined : asBoolean(data["sensitive"], false),
        extra: {},
    };
}
/** Filename for a record: `<id>.md` is enough; title is in frontmatter.
 * Ids are engine-generated [a-z0-9]{26}, so this is a no-op for them; it
 * guards imported/legacy ids so `${id}` cannot escape the shard directory. */
export function recordFileName(id) {
    return `${id.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80)}.md`;
}
/** Human-readable index line, e.g. `- [Title](mem_x.md) 📌 — description`. */
export function indexLine(record) {
    const pin = record.pinned ? " 📌" : "";
    const type = record.type ? `[${record.type}] ` : "";
    const desc = record.description ? ` — ${record.description}` : "";
    return `- ${type}[${record.title}](${recordFileName(record.id)})${pin}${desc}`;
}
//# sourceMappingURL=frontmatter.js.map