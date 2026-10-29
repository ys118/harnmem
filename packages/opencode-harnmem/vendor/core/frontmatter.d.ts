/**
 * YAML-subset frontmatter parser/serializer + MemoryRecord mapping.
 *
 * We intentionally do NOT implement full YAML: only the canonical subset the
 * engine writes (scalars, inline arrays, block arrays, one nested map). Parsing
 * is tolerant: unknown keys are preserved in `extra`, malformed lines are kept
 * in `raw` so `doctor` can report them instead of losing data.
 */
import type { MemoryRecord } from "./types.js";
export interface ParsedFrontmatter {
    data: Record<string, unknown>;
    body: string;
    /** True when the file had no frontmatter at all. */
    noFrontmatter: boolean;
}
/** Minimal YAML subset parser. */
export declare function parseYamlSubset(yaml: string): {
    data: Record<string, unknown>;
    errors: string[];
};
export declare function parseFrontmatter(raw: string): ParsedFrontmatter & {
    errors: string[];
};
/** Serialize a MemoryRecord into a markdown file with canonical frontmatter. */
export declare function serializeRecord(record: MemoryRecord): string;
export declare function recordFromFrontmatter(data: Record<string, unknown>, body: string, fallbackId: string, now: number): MemoryRecord;
/** Filename for a record: `<id>.md` is enough; title is in frontmatter. */
export declare function recordFileName(id: string): string;
/** Human-readable index line, e.g. `- [Title](mem_x.md) 📌 — description`. */
export declare function indexLine(record: MemoryRecord): string;
//# sourceMappingURL=frontmatter.d.ts.map