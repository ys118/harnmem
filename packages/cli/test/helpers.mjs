/**
 * Shared helpers for the CLI end-to-end tests.
 *
 * The tests spawn the real binary (`dist/main.js`) the way a user would, with
 * every legacy store redirected into a temporary directory, so nothing on the
 * machine is ever read or written. Run `pnpm --filter @harnmem/cli build`
 * first (the package `test` script does that).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const CLI = resolve(here, "..", "dist", "main.js");
export const REPO_ROOT = resolve(here, "..", "..", "..");

/** A unique temp directory; callers are responsible for cleanup (or leave it). */
export async function makeTemp(prefix) {
  return mkdtemp(join(tmpdir(), `harnmem-cli-${prefix}-`));
}

/**
 * Environment for a spawned CLI: the caller's environment minus HarnMem
 * switches, plus explicit overrides. Stores are always redirected by the tests.
 */
export function envFor(overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    "HARNMEM_HOME",
    "HARNMEM_DISABLED",
    "HARNMEM_READONLY",
    "DSH_HOME",
    "PI_CODING_AGENT_DIR",
    "ZCODE_HOME",
    "CLAUDE_CONFIG_DIR",
  ]) {
    delete env[key];
  }
  return Object.assign(env, overrides);
}

/** Spawn the CLI and collect stdout/stderr. Never rejects on a non-zero exit. */
export function runCli(args, { env, cwd, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: env ?? envFor(),
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: -1, stdout, stderr: String(error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

/** Run the CLI with `--json` and parse the JSON payload (pretty-printed on stdout). */
export async function runCliJson(args, options) {
  const result = await runCli([...args, "--json"], options);
  const text = result.stdout.trim();
  if (text === "") {
    throw new Error(
      `expected JSON output from \`${args.join(" ")}\` (exit ${result.code}) — stderr:\n${result.stderr}`,
    );
  }
  try {
    return { ...result, data: JSON.parse(text) };
  } catch {
    const last = text.split(/\r?\n/).at(-1);
    try {
      return { ...result, data: JSON.parse(last) };
    } catch {
      throw new Error(
        `stdout is not JSON from \`${args.join(" ")}\`:\n${text}\nstderr:\n${result.stderr}`,
      );
    }
  }
}

/** Create an isolated legacy-store layout: returns { root, home, env }. */
export async function isolatedStores(prefix) {
  const root = await makeTemp(prefix);
  const home = join(root, "home");
  const dsh = join(root, "dsh");
  const pi = join(root, "pi", "agent");
  const zcode = join(root, "zcode");
  const claude = join(root, "claude");
  const env = envFor({
    HARNMEM_HOME: home,
    DSH_HOME: dsh,
    PI_CODING_AGENT_DIR: pi,
    ZCODE_HOME: zcode,
    CLAUDE_CONFIG_DIR: claude,
  });
  return { root, home, dsh, pi, zcode, claude, env };
}

/** Write a file, creating parent directories. */
export async function write(path, content) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

/** Count imported memory files (excludes the MEMORY.md index). */
export async function countMemories(home) {
  const dir = join(home, "memories");
  if (!existsSync(dir)) return 0;
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((name) => name.endsWith(".md") && !name.endsWith("MEMORY.md")).length;
}

/** Read every imported memory body (recursive; excludes MEMORY.md). */
export async function readMemoryBodies(home) {
  const dir = join(home, "memories");
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true });
  const files = entries.filter((name) => name.endsWith(".md") && !name.endsWith("MEMORY.md"));
  const { readFile } = await import("node:fs/promises");
  return Promise.all(files.map((name) => readFile(join(dir, name), "utf8")));
}

/** Absolute path to the shipped prompts (used to assert the migration recipe exists). */
export function shippedPrompt(name) {
  return join(REPO_ROOT, "prompts", name);
}
