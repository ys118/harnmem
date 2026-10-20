/**
 * Minimal dependency-free argument parser.
 *
 * Grammar:  harnmem <command> [subcommand] [positionals...] [--flag[=value]]
 *
 * Flags are declared per command so that a typo is a usage error (exit 2)
 * instead of being silently ignored. Booleans accept `--flag` and `--flag=true`
 * but never consume the next token; value flags accept `--flag value` and
 * `--flag=value`.
 */

export type FlagKind = "boolean" | "string" | "number" | "repeat";

export interface FlagSpec {
  kind: FlagKind;
  /** Short alias, e.g. `-h` for `--help`. */
  alias?: string;
  /** For `repeat`: collect every occurrence (e.g. `--tag a --tag b`). */
  values?: string[];
}

export interface ParsedArgs {
  /** `stats`, `search`, ... ; undefined when only `--help` was given. */
  command?: string;
  subcommand?: string;
  positionals: string[];
  flags: Record<string, string | number | boolean | string[]>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Common flags available on every command. */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  home: { kind: "string" },
  cwd: { kind: "string" },
  project: { kind: "string" },
  json: { kind: "boolean" },
  "no-color": { kind: "boolean" },
  help: { kind: "boolean", alias: "h" },
  version: { kind: "boolean" },
};

function lookup(specs: Record<string, FlagSpec>, name: string): { key: string; spec: FlagSpec } | null {
  const direct = specs[name];
  if (direct) return { key: name, spec: direct };
  for (const [key, spec] of Object.entries(specs)) {
    if (spec.alias === name) return { key, spec };
  }
  return null;
}

function coerceNumber(key: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${key} expects a number, got "${raw}"`);
  return value;
}

/** Parse argv (without node/script) against the given flag specs. */
export function parseArgs(argv: string[], specs: Record<string, FlagSpec>): ParsedArgs {
  const all: Record<string, FlagSpec> = { ...GLOBAL_FLAGS, ...specs };
  const parsed: ParsedArgs = { positionals: [], flags: {} };
  let onlyPositionals = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (onlyPositionals) {
      parsed.positionals.push(token);
      continue;
    }
    if (token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      // The command word is split off by main before parsing; every bare token
      // left here is a positional argument (search query, memory id, run id...).
      parsed.positionals.push(token);
      continue;
    }
    if (!token.startsWith("--")) throw new UsageError(`unknown option "${token}"`);
    const eq = token.indexOf("=");
    const rawName = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const found = lookup(all, rawName);
    if (!found) throw new UsageError(`unknown option "--${rawName}"`);
    const { key, spec } = found;
    if (spec.kind === "boolean") {
      const value = inline === undefined ? true : inline !== "false" && inline !== "0";
      parsed.flags[key] = value;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`--${key} expects a value`);
    if (spec.kind === "number") parsed.flags[key] = coerceNumber(key, value);
    else if (spec.kind === "repeat") {
      const list = Array.isArray(parsed.flags[key]) ? (parsed.flags[key] as string[]) : [];
      list.push(value);
      parsed.flags[key] = list;
    } else parsed.flags[key] = value;
  }
  return parsed;
}

export function flagBool(parsed: ParsedArgs, key: string, fallback = false): boolean {
  const value = parsed.flags[key];
  return typeof value === "boolean" ? value : fallback;
}

export function flagString(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  return typeof value === "string" ? value : undefined;
}

export function flagNumber(parsed: ParsedArgs, key: string): number | undefined {
  const value = parsed.flags[key];
  return typeof value === "number" ? value : undefined;
}

export function flagList(parsed: ParsedArgs, key: string): string[] {
  const value = parsed.flags[key];
  return Array.isArray(value) ? value : [];
}

/** Reject flags that this command does not declare (defensive for aliases). */
export function requireValue(parsed: ParsedArgs, key: string, what: string): string {
  const value = flagString(parsed, key);
  if (value === undefined || value === "") throw new UsageError(`missing ${what} (--${key})`);
  return value;
}
