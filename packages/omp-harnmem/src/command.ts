/**
 * `/memory` slash command. Mirrors the tools for human use, plus restore,
 * consolidate and extraction diagnostics that the model does not need.
 *
 * In the TUI output goes through ctx.ui.notify; in headless modes it is printed
 * to stdout so `pi -p` runs stay scriptable.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { formatConsolidation, formatForget, formatRead, formatSearch, formatStats } from "./format.js";
import type { Adapter } from "./state.js";

const HELP = [
  "harnmem memory commands:",
  "  /memory status                      store health, counts, extraction backlog",
  "  /memory search <query> [flags]      search memories",
  "      flags: --limit N  --scope user|project|all  --as-of YYYY-MM-DD",
  "             --entity NAME  --archived  --history  --debug",
  "  /memory read <id> [--history] [--as-of YYYY-MM-DD]",
  "  /memory forget <id> [--hard]        trash (or permanently delete) a record",
  "  /memory restore <id>                restore from trash",
  "  /memory consolidate [--dry-run] [--mechanical]",
  "  /memory help                        this help",
].join("\n");

/** Flags that consume the next token as their value. */
const VALUE_FLAGS = new Set(["limit", "scope", "as-of", "as_of", "entity", "id"]);

interface ParsedArgs {
  positional: string[];
  floats: Set<string>;
  values: Map<string, string>;
}

function parseArgs(rest: string[]): ParsedArgs {
  const positional: string[] = [];
  const floats = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (VALUE_FLAGS.has(name) && i + 1 < rest.length && !(rest[i + 1] as string).startsWith("--")) {
      values.set(name, rest[i + 1] as string);
      i++;
    } else {
      floats.add(name);
    }
  }
  return { positional, floats, values };
}

function numberFlag(values: Map<string, string>, name: string): number | undefined {
  const raw = values.get(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emit(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  try {
    if (ctx.hasUI) {
      ctx.ui.notify(text, level);
      return;
    }
  } catch {
    // fall through to stdout
  }
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

export function registerCommand(pi: ExtensionAPI, adapter: Adapter): void {
  pi.registerCommand("memory", {
    description: "HarnMem long-term memory: status | search | read | forget | restore | consolidate",
    getArgumentCompletions: (prefix) => {
      const subcommands = ["status", "search", "read", "forget", "restore", "consolidate", "help"];
      const matches = subcommands.filter((s) => s.startsWith(prefix.split(/\s+/)[0] ?? ""));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0] ?? "status";
      const parsed = parseArgs(tokens.slice(1));
      const { positional, floats: flags, values } = parsed;

      if (sub === "help" || sub === "?") {
        emit(ctx, HELP);
        return;
      }
      const eng = await adapter.ensureEngine(ctx);
      if (!eng) {
        emit(ctx, "harnmem: memory store unavailable in this session (see logs)", "error");
        return;
      }

      try {
        switch (sub) {
          case "status": {
            emit(ctx, formatStats(await eng.stats()));
            return;
          }
          case "search": {
            const query = positional.join(" ").trim();
            if (!query) {
              emit(ctx, "usage: /memory search <query> [--limit N] [--scope user|project|all] [--as-of DATE] [--entity NAME] [--archived] [--history] [--debug]", "warning");
              return;
            }
            const scope = values.get("scope");
            if (scope !== undefined && !["user", "project", "all"].includes(scope)) {
              emit(ctx, `unknown --scope "${scope}" (use user|project|all)`, "warning");
              return;
            }
            const asOf = values.get("as-of") ?? values.get("as_of");
            const result = await eng.search({
              query,
              limit: numberFlag(values, "limit"),
              scope: scope as "user" | "project" | "all" | undefined,
              asOf,
              entity: values.get("entity"),
              includeArchived: flags.has("archived") || flags.has("include-archived"),
              includeHistory: flags.has("history"),
              debug: flags.has("debug"),
            });
            emit(ctx, formatSearch(result));
            return;
          }
          case "read": {
            const id = values.get("id") ?? positional[0];
            if (!id) {
              emit(ctx, "usage: /memory read <id> [--history] [--as-of YYYY-MM-DD]", "warning");
              return;
            }
            const result = await eng.read(id, {
              includeHistory: flags.has("history"),
              asOf: values.get("as-of") ?? values.get("as_of"),
            });
            emit(ctx, formatRead(result, id), result ? "info" : "warning");
            return;
          }
          case "forget": {
            const id = positional[0];
            if (!id) {
              emit(ctx, "usage: /memory forget <id> [--hard]", "warning");
              return;
            }
            const result = await eng.forget(id, { hard: flags.has("hard") });
            adapter.markDirty("memory_write");
            emit(ctx, formatForget(result), result.ok ? "info" : "warning");
            return;
          }
          case "restore": {
            const id = positional[0];
            if (!id) {
              emit(ctx, "usage: /memory restore <id>", "warning");
              return;
            }
            const result = await eng.restore(id);
            adapter.markDirty("memory_write");
            emit(ctx, result.ok ? `restored ${id}` : `could not restore ${id}`, result.ok ? "info" : "warning");
            return;
          }
          case "consolidate": {
            const report = await eng.consolidate({
              dryRun: flags.has("dry-run"),
              mechanicalOnly: flags.has("mechanical"),
            });
            if (!flags.has("dry-run") && (report.merged.length || report.archived.length || report.digestsWritten.length)) {
              adapter.markDirty("manual");
            }
            emit(ctx, formatConsolidation(report));
            return;
          }
          default:
            emit(ctx, `unknown subcommand "${sub}"\n\n${HELP}`, "warning");
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        adapter.logger?.warn("command.error", { sub, error: message });
        emit(ctx, `memory ${sub} failed: ${message}`, "error");
      }
    },
  });
}
