#!/usr/bin/env node
/**
 * `harnmem` CLI entry point: argument routing, help, exit codes.
 *
 * Exit codes: 0 ok, 1 runtime/verification failure, 2 usage error.
 */

import { resolve } from "node:path";

import { flagBool, flagString, parseArgs, UsageError, type FlagSpec, type ParsedArgs } from "./args.js";
import {
  cmdConsolidate,
  cmdExport,
  cmdForget,
  cmdHelp,
  cmdImport,
  cmdImportHelp,
  cmdRead,
  cmdRebuild,
  cmdRestore,
  cmdSearch,
  cmdStats,
  cmdWrite,
  EXIT,
  IMPORT_SUBCOMMANDS,
  printMainHelp,
  resolveHomeFlag,
  VERSION,
} from "./commands.js";
import { cmdSynonyms, printSynonymsHelp, SYNONYMS_SUBCOMMANDS } from "./synonyms.js";
import { Output } from "./output.js";

const COMMAND_FLAGS: Record<string, Record<string, FlagSpec>> = {
  stats: {},
  search: {
    limit: { kind: "number" },
    scope: { kind: "string" },
    "include-archived": { kind: "boolean" },
    history: { kind: "boolean" },
    "as-of": { kind: "string" },
    entity: { kind: "string" },
    debug: { kind: "boolean" },
  },
  read: {
    history: { kind: "boolean" },
    "as-of": { kind: "string" },
  },
  write: {
    type: { kind: "string" },
    title: { kind: "string" },
    description: { kind: "string" },
    content: { kind: "string" },
    "content-file": { kind: "string" },
    category: { kind: "string" },
    scope: { kind: "string" },
    tags: { kind: "string" },
    entity: { kind: "repeat" },
    importance: { kind: "number" },
    confidence: { kind: "number" },
    pinned: { kind: "boolean" },
    link: { kind: "repeat" },
    supersedes: { kind: "repeat" },
    sensitive: { kind: "boolean" },
  },
  forget: { hard: { kind: "boolean" } },
  restore: {},
  consolidate: {
    "dry-run": { kind: "boolean" },
    "mechanical-only": { kind: "boolean" },
    "max-llm-calls": { kind: "number" },
  },
  rebuild: {},
  index: {},
  export: { out: { kind: "string" } },
  import: {
    from: { kind: "string" },
    path: { kind: "string" },
    sessions: { kind: "string" },
    "path-map": { kind: "repeat" },
    "dry-run": { kind: "boolean" },
    apply: { kind: "boolean" },
    yes: { kind: "boolean" },
    verify: { kind: "boolean" },
    rollback: { kind: "string" },
    "skip-daily": { kind: "boolean" },
  },
  help: {},
  version: {},
  synonyms: {
    write: { kind: "boolean" },
    out: { kind: "string" },
    "dump-prompt": { kind: "boolean" },
    "from-response": { kind: "string" },
    language: { kind: "string" },
    "llm-url": { kind: "string" },
    "llm-model": { kind: "string" },
    "llm-api-key": { kind: "string" },
    "no-sessions": { kind: "boolean" },
    "session-files": { kind: "number" },
    "max-groups": { kind: "number" },
    "max-terms": { kind: "number" },
    "min-support": { kind: "number" },
    file: { kind: "string" },
    limit: { kind: "number" },
    k: { kind: "number" },
  },
};

const SUBCOMMANDS: Record<string, Set<string>> = {
  import: new Set<string>([...IMPORT_SUBCOMMANDS, "help"]),
  synonyms: new Set<string>([...SYNONYMS_SUBCOMMANDS]),
};

interface SplitCommand {
  command: string;
  subcommand?: string;
  rest: string[];
}

/**
 * `harnmem [<command> [<subcommand>]] [flags...]`. Flags are expected after the
 * command words; global flags before the command are not supported by design.
 */
function splitCommand(argv: string[]): SplitCommand {
  const first = argv[0];
  if (first === undefined || first.startsWith("-")) return { command: "help", rest: argv };
  const command = first;
  let rest = argv.slice(1);
  let subcommand: string | undefined;
  const allowed = SUBCOMMANDS[command];
  if (allowed) {
    const candidate = rest[0];
    if (candidate !== undefined && !candidate.startsWith("-") && allowed.has(candidate)) {
      subcommand = candidate;
      rest = rest.slice(1);
    }
  }
  return { command, subcommand, rest };
}

async function run(argv: string[]): Promise<number> {
  const { command, subcommand, rest } = splitCommand(argv);
  const specs = COMMAND_FLAGS[command];
  if (!specs) {
    process.stderr.write(`unknown command "${command}"\n`);
    return EXIT.USAGE;
  }
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(rest, specs);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`usage error: ${err.message}\n`);
      return EXIT.USAGE;
    }
    throw err;
  }
  parsed.command = command;
  parsed.subcommand = subcommand;

  const json = flagBool(parsed, "json") || process.env.HARNMEM_JSON === "1";
  const color =
    !flagBool(parsed, "no-color") && !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
  const out = new Output(json, { color });

  if (flagBool(parsed, "version")) {
    out.line(VERSION);
    return EXIT.OK;
  }
  const home = resolveHomeFlag(parsed);
  const cwd = resolve(flagString(parsed, "cwd") ?? process.cwd());
  if (flagBool(parsed, "help")) {
    return command === "synonyms" ? printSynonymsHelp(out) : cmdHelp(parsed, out);
  }

  switch (command) {
    case "stats":
      return cmdStats(parsed, out, home, cwd);
    case "search":
      return cmdSearch(parsed, out, home, cwd);
    case "read":
      return cmdRead(parsed, out, home, cwd);
    case "write":
      return cmdWrite(parsed, out, home, cwd);
    case "forget":
      return cmdForget(parsed, out, home, cwd);
    case "restore":
      return cmdRestore(parsed, out, home, cwd);
    case "consolidate":
      return cmdConsolidate(parsed, out, home, cwd);
    case "rebuild":
      return cmdRebuild(parsed, out, home, cwd);
    case "index":
      return cmdRebuild(parsed, out, home, cwd);
    case "export":
      return cmdExport(parsed, out, home, cwd);
    case "import":
      return cmdImport(parsed, out, home, cwd);
    case "synonyms":
      return cmdSynonyms(parsed, out, home, cwd);
    case "help":
      return printMainHelp(out);
    case "version":
      out.line(VERSION);
      return EXIT.OK;
    default:
      return cmdImportHelp(out);
  }
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${err instanceof UsageError ? "usage error" : "error"}: ${message}\n`);
    if (process.env.HARNMEM_DEBUG && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = err instanceof UsageError ? EXIT.USAGE : EXIT.FAIL;
  },
);
