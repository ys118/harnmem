/**
 * Engine construction for the opencode adapter.
 *
 * The only constraint face is @harnmem/core (vendored at build time into
 * vendor/core so the plugin directory is self-contained once installed).
 * See docs/design/07-adapter-contract.md: adapters never contain
 * retrieval/storage logic.
 */

import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CORE_INDEX = path.join(here, "..", "vendor", "core", "index.js");

let corePromise = null;
async function core() {
  if (!corePromise) {
    corePromise = import(pathToFileURL(CORE_INDEX).href).catch((err) => {
      // A transient import failure (locked file, AV scan) must not poison
      // every later open in this process — clear so the next call retries.
      corePromise = null;
      throw err;
    });
  }
  return corePromise;
}

/**
 * Open a HarnMem engine. `opts.readOnly` forces read-only mode (subagent
 * sessions); `opts.sessionId`/`opts.cwd` anchor provenance and project
 * resolution. A SCHEMA_NEWER failure downgrades to read-only instead of
 * breaking the session (contract §open).
 */
export async function openEngine(settings, opts = {}) {
  const mod = await core();
  const base = {
    home: settings.home,
    harness: "opencode",
    sessionId: opts.sessionId || undefined,
    cwd: opts.cwd || process.cwd(),
    project: typeof settings.project === "string" && settings.project.trim() ? settings.project.trim() : undefined,
    readOnly: opts.readOnly === true || settings.readOnly === true,
    budget: { injectTokens: settings.maxInjectTokens },
    write: { autoExtract: settings.autoExtract === true },
    log:
      settings.debug === true
        ? (level, msg, data) => {
            try {
              process.stderr.write(`[harnmem:${level}] ${msg}${data === undefined ? "" : " " + JSON.stringify(data)}\n`);
            } catch {
              // stderr is best effort
            }
          }
        : undefined,
  };
  try {
    return await mod.HarnMem.open(base);
  } catch (err) {
    // Forward-compat per docs/design/07-adapter-contract.md: a FUTURE core
    // will throw code=SCHEMA_NEWER when its store was written by a newer
    // schema; today's core has no such error yet, so this branch is dormant.
    if (err && err.code === "SCHEMA_NEWER") {
      return mod.HarnMem.open({ ...base, readOnly: true });
    }
    throw err;
  }
}

export async function coreApi() {
  return core();
}
