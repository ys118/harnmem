/** Project attribution for legacy records (explicit map → session cwd → guessed path). */

import type { HarnessId } from "@harnmem/core";

import { isExistingDir } from "./session-cwd.js";
import { detectProject, registerProject, resolveProjectArgument, type ProjectInfo } from "./identity.js";

export interface Attribution {
  project?: ProjectInfo;
  /** Why attribution failed, for the unresolved bucket. */
  reason?: string;
  /** True when the path was a decoded directory-name guess rather than a log cwd. */
  guessed?: boolean;
}

/** Try `--path-map` keys in order; each value may be a project id or a path. */
export async function resolveFromPathMap(
  pathMap: Record<string, string>,
  keys: string[],
  home: string,
  cwd: string,
): Promise<ProjectInfo | undefined> {
  for (const key of keys) {
    const value = pathMap[key];
    if (!value) continue;
    return resolveProjectArgument(home, value, cwd);
  }
  return undefined;
}

/** Resolve and register a project from a recovered cwd. */
export async function resolveFromCwd(cwd: string, home: string, harness: HarnessId = "cli"): Promise<ProjectInfo> {
  const info = await detectProject(cwd);
  await registerProject(home, info, harness);
  return info;
}

/** Accept a decoded legacy directory name only when the path exists on disk. */
export async function resolveFromGuessedPath(path: string, home: string, harness: HarnessId): Promise<ProjectInfo | undefined> {
  if (!isExistingDir(path)) return undefined;
  return resolveFromCwd(path, home, harness);
}

/**
 * Full attribution chain for one legacy project key.
 * `sessionCwd` comes from the harness's own session logs (highest trust after
 * --path-map); `decodedPath` is the lossy dir-name guess.
 */
export async function attributeProject(options: {
  keys: string[];
  pathMap: Record<string, string>;
  home: string;
  cwd: string;
  harness: HarnessId;
  sessionCwd?: string;
  decodedPath?: string;
  fallback?: ProjectInfo;
}): Promise<Attribution> {
  try {
    const mapped = await resolveFromPathMap(options.pathMap, options.keys, options.home, options.cwd);
    if (mapped) return { project: mapped };
  } catch (err) {
    return { reason: `--path-map error: ${(err as Error).message}` };
  }
  if (options.sessionCwd) {
    try {
      return { project: await resolveFromCwd(options.sessionCwd, options.home, options.harness) };
    } catch (err) {
      return { reason: `session cwd ${options.sessionCwd} failed: ${(err as Error).message}` };
    }
  }
  if (options.decodedPath) {
    try {
      const guessed = await resolveFromGuessedPath(options.decodedPath, options.home, options.harness);
      if (guessed) return { project: guessed, guessed: true };
    } catch {
      // fall through
    }
  }
  if (options.fallback) return { project: options.fallback, guessed: true, reason: "fallback project (--project)" };
  return { reason: `no session-log cwd, --path-map entry, or existing path for legacy key "${options.keys[0] ?? "?"}"` };
}
