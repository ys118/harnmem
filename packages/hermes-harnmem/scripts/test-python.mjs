#!/usr/bin/env node
/**
 * Run the Python side of the plugin: the MemoryProvider and CLI translation.
 *
 * Node tests cover the bridge; Hermes loads Python, so the provider contract
 * (config schema, prefetch caching, tool dispatch, detached extraction) can
 * only be verified in Python. The check is skipped with a warning when no
 * Python 3 interpreter is available; Node-based consumers still get coverage.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const testDir = path.join(packageRoot, "test", "python");

const candidates = [];
if (process.env.PYTHON) candidates.push([process.env.PYTHON]);
if (process.platform === "win32") candidates.push(["py", "-3"]);
candidates.push(["python3"], ["python"]);

function findPython() {
  for (const candidate of candidates) {
    const [binary, ...args] = candidate;
    const probe = spawnSync(binary, [...args, "-c", "import sys; print(sys.version_info[0])"], {
      encoding: "utf8",
    });
    if (probe.status === 0 && probe.stdout.trim() === "3") return candidate;
    if (probe.error && probe.error.code === "ENOENT") continue;
  }
  return null;
}

const python = findPython();
if (python === null) {
  console.warn("[hermes-harnmem] no Python 3 interpreter found; skipping Python plugin tests");
  process.exit(0);
}

const [binary, ...args] = python;
const result = spawnSync(
  binary,
  [...args, "-m", "unittest", "discover", "-s", testDir, "-p", "test_*.py", "-v"],
  { cwd: packageRoot, stdio: "inherit" },
);
process.exit(result.status === null ? 1 : result.status);
