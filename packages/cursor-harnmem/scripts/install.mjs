#!/usr/bin/env node
/**
 * Install the HarnMem Cursor plugin into a user's Cursor configuration.
 *
 * Cursor desktop 3.27.22 has two independent extension points that HarnMem
 * needs, and they are loaded differently:
 *
 *  - `.cursor/plugins/local/<name>/` provides `rules/` and `mcp.json` (both
 *    verified working). Its `hooks/hooks.json` is gated behind the
 *    `enable_cc_plugin_import` experiment: after a Developer: Reload Window it
 *    is usually skipped, but after a full Cursor restart it can be scheduled
 *    alongside the user-level hooks (verified, see
 *    docs/research/cursor-plugin.md §2.7). The user-level `~/.cursor/hooks.json`
 *    is therefore the authoritative channel (verified, hot reloaded), and the
 *    hook script dedupes the two channels with exclusive claim files.
 *  - The MCP server can come from the plugin (`plugin-harnmem-harnmem`) or
 *    from `~/.cursor/mcp.json` (`--mcp-user`); the user-level file is the
 *    fallback for builds where plugin MCP loading is unavailable.
 *
 * The installer never overwrites user content: `hooks.json` and `mcp.json` are
 * read, merged and written back with a timestamped backup, and our entries are
 * identified by their command path on uninstall.
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDoctorReport,
  claudePluginRegistryPath,
  findClaudePluginInstalls,
} from "../lib/doctor.mjs";
import {
  mergeHooksConfig,
  mergeMcpConfig,
  readJsonFile,
  removeHooksConfig,
  removeMcpConfig,
} from "../lib/install-hooks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const hookScript = path.join(pluginRoot, "hooks", "hook.mjs");

const COPY_SKIP = new Set(["test", "node_modules", ".git", ".tmp"]);

function parseArgs(argv) {
  const opts = { dryRun: false, uninstall: false, mcpUser: false, doctor: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--uninstall") opts.uninstall = true;
    else if (arg === "--mcp-user") opts.mcpUser = true;
    else if (arg === "--doctor") opts.doctor = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else {
      console.error(`unknown argument: ${arg}`);
      opts.help = true;
    }
  }
  return opts;
}

function usage() {
  return [
    "Usage: node scripts/install.mjs [--dry-run] [--mcp-user] [--uninstall] [--doctor]",
    "",
    "  --dry-run    print planned actions without touching the filesystem",
    "  --mcp-user   also register the MCP server in ~/.cursor/mcp.json",
    "  --uninstall  remove hooks, the MCP entry (when present) and the plugin copy",
    "  --doctor     check the installed plugin, hooks, MCP server and Claude Code",
    "               coexistence (exit 1 when a required piece is missing)",
    "",
    "Environment: HARNMEM_CURSOR_HOME overrides the Cursor config directory",
    "(default: ~/.cursor); HARNMEM_CLAUDE_HOME overrides the Claude Code config",
    "directory (default: ~/.claude).",
  ].join("\n");
}

function cursorHome() {
  const override = process.env.HARNMEM_CURSOR_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), ".cursor");
}

function claudeHome() {
  const override = process.env.HARNMEM_CLAUDE_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), ".claude");
}

async function readJson(file) {
  if (!existsSync(file)) return undefined;
  try {
    return await readJsonFile(file, readFile);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); refusing to overwrite it`);
  }
}

/** Like `readJson`, but a broken file is reported instead of thrown. */
async function readJsonTolerant(file) {
  if (!existsSync(file)) return undefined;
  try {
    return await readJsonFile(file, readFile);
  } catch (err) {
    console.log(`  note: ${file} is not valid JSON (${err.message}); skipped`);
    return undefined;
  }
}

async function collectClaudeInstalls() {
  const registry = await readJsonTolerant(claudePluginRegistryPath(claudeHome()));
  return findClaudePluginInstalls(registry);
}

async function collectDoctorReport(root) {
  const pluginTarget = path.join(root, "plugins", "local", "harnmem");
  const hooksFile = path.join(root, "hooks.json");
  const installedHook = path.join(pluginTarget, "hooks", "hook.mjs");
  return buildDoctorReport({
    pluginDir: pluginTarget,
    pluginManifest: await readJsonTolerant(path.join(pluginTarget, ".cursor-plugin", "plugin.json")),
    pluginMcpConfig: await readJsonTolerant(path.join(pluginTarget, "mcp.json")),
    userMcpConfig: await readJsonTolerant(path.join(root, "mcp.json")),
    hooksConfig: await readJsonTolerant(hooksFile),
    hookScriptPath: installedHook,
    claudeInstalls: await collectClaudeInstalls(),
  });
}

function printDoctorReport(report, { verbose }) {
  for (const check of report.checks) {
    if (!verbose && check.status === "ok") continue;
    console.log(`  ${check.status === "ok" ? "ok   " : check.status === "warn" ? "warn " : "MISS "} ${check.id}: ${check.detail}`);
  }
  for (const line of report.warnings) console.log(`  WARNING: ${line}`);
  for (const line of report.problems) console.log(`  PROBLEM: ${line}`);
}

async function doctor(root) {
  console.log("HarnMem for Cursor — doctor");
  const report = await collectDoctorReport(root);
  printDoctorReport(report, { verbose: true });
  if (report.problems.length === 0) {
    console.log("");
    console.log("Result: installed and registered.");
  } else {
    console.log("");
    console.log("Result: incomplete installation -> run: node scripts/install.mjs");
  }
  return report.problems.length === 0;
}

async function writeJson(file, value, { dryRun }) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (dryRun) {
    console.log(`[dry-run] write ${file}`);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  if (existsSync(file)) {
    const backup = `${file}.bak-${Date.now()}`;
    await cp(file, backup);
    console.log(`  backup: ${backup}`);
  }
  await writeFile(file, body, "utf8");
  console.log(`  wrote: ${file}`);
}

async function copyPlugin(target, { dryRun }) {
  if (dryRun) {
    console.log(`[dry-run] copy ${pluginRoot} -> ${target}`);
    return;
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(pluginRoot, target, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return !COPY_SKIP.has(base);
    },
  });
  console.log(`  plugin: ${target}`);
}

async function install({ dryRun, mcpUser }) {
  console.log(`HarnMem for Cursor — install${dryRun ? " (dry run)" : ""}`);
  const root = cursorHome();
  const pluginTarget = path.join(root, "plugins", "local", "harnmem");
  const hooksFile = path.join(root, "hooks.json");
  const mcpFile = path.join(root, "mcp.json");

  console.log("1) plugin directory (rules + MCP manifest)");
  await copyPlugin(pluginTarget, { dryRun });
  const installedHook = path.join(pluginTarget, "hooks", "hook.mjs");

  console.log("2) user hooks (~/.cursor/hooks.json)");
  const existingHooks = await readJson(hooksFile);
  const merged = mergeHooksConfig(existingHooks, { hookScriptPath: installedHook });
  if (merged.changed) {
    const events = merged.added.join(", ");
    console.log(`  register: ${events}`);
    await writeJson(hooksFile, merged.config, { dryRun });
  } else {
    console.log("  already registered (no change)");
  }

  if (mcpUser) {
    console.log("3) user MCP server (~/.cursor/mcp.json)");
    const existingMcp = await readJson(mcpFile);
    await writeJson(mcpFile, mergeMcpConfig(existingMcp, { pluginRoot: pluginTarget }), { dryRun });
  }

  if (!dryRun) {
    console.log(`${mcpUser ? "4" : "3"}) doctor`);
    const report = await collectDoctorReport(root);
    printDoctorReport(report, { verbose: false });
    if (report.warnings.length === 0 && report.problems.length === 0) {
      console.log("  ok    plugin, hooks and MCP server are registered correctly");
    }
  }

  if (!dryRun) {
    console.log("");
    console.log("Next: reload the Cursor window (Developer: Reload Window) or restart Cursor.");
    console.log("The plugin provides: rules/harnmem.mdc (fallback context) + mcp.json (memory tools).");
    console.log("Hooks in ~/.cursor/hooks.json provide: first-prompt injection + session-end journaling.");
    console.log(`Restore state: node scripts/install.mjs --uninstall${mcpUser ? " --mcp-user" : ""}`);
    console.log("Re-check later with: node scripts/install.mjs --doctor");
  }
}

async function uninstall({ dryRun, mcpUser }) {
  console.log(`HarnMem for Cursor — uninstall${dryRun ? " (dry run)" : ""}`);
  const root = cursorHome();
  const pluginTarget = path.join(root, "plugins", "local", "harnmem");
  const hooksFile = path.join(root, "hooks.json");
  const mcpFile = path.join(root, "mcp.json");
  const installedHook = path.join(pluginTarget, "hooks", "hook.mjs");

  const existingHooks = await readJson(hooksFile);
  if (existingHooks !== undefined) {
    const cleaned = removeHooksConfig(existingHooks, { hookScriptPath: installedHook });
    if (cleaned.removed > 0) {
      console.log(`1) hooks: remove ${cleaned.removed} entr${cleaned.removed === 1 ? "y" : "ies"}`);
      await writeJson(hooksFile, cleaned.config, { dryRun });
    } else {
      console.log("1) hooks: nothing registered (no change)");
    }
  } else {
    console.log("1) hooks: no hooks.json (no change)");
  }

  const existingMcp = await readJson(mcpFile);
  if (mcpUser && existingMcp !== undefined && existingMcp.mcpServers?.harnmem) {
    console.log("2) MCP: remove user-level harnmem server");
    await writeJson(mcpFile, removeMcpConfig(existingMcp), { dryRun });
  } else {
    console.log("2) MCP: nothing to remove");
  }

  if (existsSync(pluginTarget)) {
    const manifest = await readJson(path.join(pluginTarget, ".cursor-plugin", "plugin.json"));
    if (manifest?.name !== "harnmem") {
      throw new Error(`${pluginTarget} does not look like the HarnMem plugin; refusing to delete it`);
    }
    if (dryRun) console.log(`[dry-run] remove ${pluginTarget}`);
    else {
      await rm(pluginTarget, { recursive: true, force: true });
      console.log(`3) plugin: removed ${pluginTarget}`);
    }
  } else if (!dryRun) {
    console.log("3) plugin: not installed (no change)");
  }

  if (!dryRun) {
    console.log("");
    console.log("Reload the Cursor window to unload the plugin. Memory store in ~/.harnmem is untouched.");
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return;
  }
  await stat(hookScript); // fail fast when run from a broken tree
  if (opts.doctor) {
    const ok = await doctor(cursorHome());
    if (!ok) process.exitCode = 1;
    return;
  }
  if (opts.uninstall) await uninstall(opts);
  else await install(opts);
}

main().catch((err) => {
  console.error(`install failed: ${err?.message || err}`);
  process.exit(1);
});
