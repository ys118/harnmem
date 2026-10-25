/**
 * YAML frontmatter for legacy memory files (dsh-auto-memory, zcode).
 *
 * Zero-dependency subset parser: scalars (quoted/unquoted), numbers, booleans,
 * null, inline `[a, b]` arrays, block `- item` lists, and inline JSON objects.
 * Unknown/unsupported syntax is preserved as a plain string rather than
 * throwing — migration prefers lossy-but-continuing over aborting a whole file.
 */

export type FrontmatterValue = string | number | boolean | null | string[] | Record<string, unknown>;

export interface ParsedFrontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
  /** True when the file opened with a `---` marker (even if empty). */
  hasFrontmatter: boolean;
}

const FENCE = /^(?:---|\+\+\+)\s*$/;

function splitInlineArray(raw: string): string[] {
  let inner = raw.trim();
  if (inner.startsWith("[")) inner = inner.slice(1);
  if (inner.endsWith("]")) inner = inner.slice(0, -1);
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") out.push(current.trim());
  return out;
}

function unquote(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return String(JSON.parse(text));
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

export function parseScalar(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitInlineArray(trimmed).map((item) => unquote(item));
  }
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to string
    }
  }
  if (trimmed === "true" || trimmed === "True") return true;
  if (trimmed === "false" || trimmed === "False") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  return unquote(trimmed);
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  // Strip a UTF-8 BOM and normalize newlines; keep the original body verbatim
  // apart from the single blank line that typically follows the closing fence.
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  let cursor = 0;
  while (cursor < lines.length && (lines[cursor] ?? "").trim() === "") cursor++;
  if (cursor >= lines.length || !FENCE.test(lines[cursor] ?? "")) {
    return { data: {}, body: text.trim(), hasFrontmatter: false };
  }
  const data: Record<string, FrontmatterValue> = {};
  let i = cursor + 1;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) break;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) continue; // tolerate stray indentation / flow errors
    const key = match[1] ?? "";
    const rest = match[2] ?? "";
    if (rest.trim() === "") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const item = /^\s*-\s+(.*)$/.exec(lines[j] ?? "");
        if (!item) break;
        items.push(unquote(item[1] ?? ""));
        j++;
      }
      if (items.length > 0) {
        data[key] = items;
        i = j - 1;
      } else data[key] = "";
    } else {
      data[key] = parseScalar(rest);
    }
  }
  const body = lines
    .slice(Math.min(i + 1, lines.length))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\s+$/, "");
  return { data, body, hasFrontmatter: true };
}

export function fmString(data: Record<string, FrontmatterValue>, key: string): string | undefined {
  const value = data[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function fmNumber(data: Record<string, FrontmatterValue>, key: string): number | undefined {
  const value = data[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function fmBoolean(data: Record<string, FrontmatterValue>, key: string): boolean | undefined {
  const value = data[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return undefined;
}

export function fmArray(data: Record<string, FrontmatterValue>, key: string): string[] {
  const value = data[key];
  if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
  if (typeof value === "string" && value.trim() !== "") return [value];
  return [];
}

/**
 * Read a value from a nested mapping such as `metadata:\n  type: rule`.
 *
 * `parseFrontmatter` only parses top-level keys, so indentation-nested maps are
 * recovered from the raw text. Inline-JSON parents (`metadata: {"type": "rule"}`)
 * are already objects in `data` and are handled first.
 */
export function fmNestedString(
  data: Record<string, FrontmatterValue>,
  raw: string,
  parent: string,
  child: string,
): string | undefined {
  const direct = data[parent];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const value = (direct as Record<string, unknown>)[child];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/);
  let parentIndent = -1;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const indent = (/^\s*/.exec(line) ?? [""])[0]?.length ?? 0;
    if (parentIndent < 0) {
      const parentMatch = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*$/.exec(line);
      if (parentMatch && parentMatch[1] === parent) parentIndent = indent;
      continue;
    }
    if (indent <= parentIndent) break;
    const childMatch = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.+)$/.exec(line);
    if (childMatch && childMatch[1] === child) {
      const value = parseScalar(childMatch[2] ?? "");
      if (typeof value === "string" && value.trim() !== "") return value;
      if (typeof value === "number") return String(value);
      return undefined;
    }
  }
  return undefined;
}
