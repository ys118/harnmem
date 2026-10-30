/**
 * Project identity — a faithful reimplementation of @harnmem/core's
 * `detectProject` (packages/core/src/project.ts) so the CLI can resolve
 * legacy directory names / arbitrary source paths to the same project ids the
 * core writes, without depending on non-exported internals.
 *
 * Keep in sync with core: slugify + normalizePathKey + normalizeRemoteUrl +
 * resolveGitDir + readRemotes + detectProject.
 */

import { createHash } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { HarnessId } from "@harnmem/core";

export interface ProjectInfo {
  /** `<slug>-<sha1(key)[:10]>`, e.g. `example-project-3f9a2c1b7d`. */
  id: string;
  slug: string;
  name: string;
  /** `git:<normalized remote>` or `path:<normalized absolute path>`. */
  key: string;
  root: string;
  gitRemote?: string;
}

/** Project-id shape used by core (`p-<10hex>` for non-ASCII basenames). */
export const PROJECT_ID_RE = /^[a-z0-9p][a-z0-9._-]*-[0-9a-f]{10}$/;

const SLUG_STRIP = /[\u0300-\u036f]/g;
const SLUG_RE = /[^a-z0-9._-]+/g;

export function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

export function slugify(name: string): string {
  const ascii = name.normalize("NFKD").replace(SLUG_STRIP, "").toLowerCase();
  const slug = ascii
    .replace(SLUG_RE, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 40);
  return slug || "p";
}

function isWin32(): boolean {
  return process.platform === "win32";
}

export function normalizePathKey(absPath: string): string {
  let p = resolve(absPath).replace(/\\/g, "/");
  if (isWin32()) p = p.toLowerCase();
  return p.replace(/\/+$/, "");
}

/** Git remotes, as in core project.ts (mirrored verbatim — keep in sync). */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  u = u.replace(/^git\+/, "");
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  u = u.replace(/^[^@/]+@/, "");
  u = u.replace(/^([^/:]+):(\d+)\//, "$1/");
  u = u.replace(/^([^/:]+):(?!\/)/, "$1/"); // scp-like host:path — applies even when a "/" is present later (git@host:owner/repo)
  u = u.replace(/\/+/g, "/").replace(/\/+$/, "");
  u = u.replace(/\.git$/i, "");
  const slash = u.indexOf("/");
  if (slash > 0) u = `${u.slice(0, slash).toLowerCase()}${u.slice(slash)}`;
  return u;
}

async function resolveGitDir(repoRoot: string): Promise<string | null> {
  const dotGit = join(repoRoot, ".git");
  try {
    if ((await stat(dotGit)).isDirectory()) return dotGit;
  } catch {
    return null;
  }
  try {
    const raw = await readFile(dotGit, "utf8");
    const m = /^gitdir:\s*(.+)$/m.exec(raw);
    return m ? resolve(repoRoot, (m[1] ?? "").trim()) : null;
  } catch {
    return null;
  }
}

async function readRemotes(gitDir: string): Promise<Array<{ name: string; url: string }>> {
  const remotes: Array<{ name: string; url: string }> = [];
  try {
    const config = await readFile(join(gitDir, "config"), "utf8");
    let name: string | null = null;
    let inRemote = false;
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[(.+?)\]\s*$/.exec(line);
      if (section) {
        const header = (section[1] ?? "").trim();
        const m = /^remote\s+"(.+)"$/.exec(header);
        inRemote = Boolean(m);
        name = m ? (m[1] ?? null) : null;
        continue;
      }
      if (!inRemote || !name) continue;
      const kv = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (kv && !remotes.some((r) => r.name === name)) remotes.push({ name, url: kv[1] ?? "" });
    }
  } catch {
    // no config: path fallback
  }
  return remotes;
}

/** Nearest ancestor (inclusive) containing a `.git` directory or gitfile. */
export async function findGitRepoRoot(start: string): Promise<string | null> {
  let current = resolve(start);
  for (;;) {
    try {
      const dotGit = join(current, ".git");
      const s = await stat(dotGit);
      if (s.isDirectory() || s.isFile()) return current;
    } catch {
      // keep walking up
    }
    const parent = resolve(current, "..");
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Detect the project for a cwd. Mirrors core exactly:
 * git remote wins over path so worktrees/moved repos share one project.
 */
export async function detectProject(cwd: string): Promise<ProjectInfo> {
  const absCwd = resolve(cwd);
  const repoRoot = await findGitRepoRoot(absCwd);
  if (repoRoot) {
    const gitDir = await resolveGitDir(repoRoot);
    if (gitDir) {
      const remotes = await readRemotes(gitDir);
      const preferred = remotes.find((r) => r.name === "origin") ?? remotes[0];
      if (preferred) {
        const normalized = normalizeRemoteUrl(preferred.url);
        if (normalized) {
          const repoName = normalized.split("/").filter(Boolean).pop() ?? repoRoot;
          const slug = slugify(repoName);
          return {
            id: `${slug}-${sha1Hex(`git:${normalized}`).slice(0, 10)}`,
            slug,
            name: repoName,
            key: `git:${normalized}`,
            root: repoRoot,
            gitRemote: normalized,
          };
        }
      }
    }
  }
  const root = repoRoot ?? absCwd;
  const base = root.replace(/\\/g, "/").replace(/\/+$/g, "").split("/").pop() ?? root;
  const slug = slugify(base);
  const normalizedPath = normalizePathKey(root);
  return {
    id: `${slug}-${sha1Hex(`path:${normalizedPath}`).slice(0, 10)}`,
    slug,
    name: base,
    key: `path:${normalizedPath}`,
    root,
  };
}

// ------------------------------------------------------------------ registry

export interface ProjectRegistryEntry {
  id: string;
  slug: string;
  name: string;
  paths: string[];
  harnesses: HarnessId[];
  created: number;
  updated: number;
}

interface ProjectsFile {
  version: 1;
  projects: Record<string, ProjectRegistryEntry>;
}

export function projectsFilePath(home: string): string {
  return join(home, "projects.json");
}

export async function readProjects(home: string): Promise<ProjectsFile> {
  try {
    const raw = await readFile(projectsFilePath(home), "utf8");
    const parsed = JSON.parse(raw) as Partial<ProjectsFile>;
    return { version: 1, projects: parsed.projects ?? {} };
  } catch {
    return { version: 1, projects: {} };
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** Best-effort registry upsert; the registry is advisory, never a gate. */
export async function registerProject(home: string, info: ProjectInfo, harness: HarnessId, now = Date.now()): Promise<void> {
  try {
    const file = await readProjects(home);
    const existing = file.projects[info.key];
    if (existing) {
      if (!existing.paths.includes(info.root)) existing.paths.push(info.root);
      if (!existing.harnesses.includes(harness)) existing.harnesses.push(harness);
      existing.name = info.name;
      existing.slug = info.slug;
      existing.updated = now;
    } else {
      file.projects[info.key] = {
        id: info.id,
        slug: info.slug,
        name: info.name,
        paths: [info.root],
        harnesses: [harness],
        created: now,
        updated: now,
      };
    }
    await atomicWriteJson(projectsFilePath(home), file);
  } catch {
    // registry write is advisory
  }
}

/** Find a registry entry by project id (used by `read`/`search` filters). */
export async function findProjectById(home: string, projectId: string): Promise<ProjectRegistryEntry | null> {
  const file = await readProjects(home);
  for (const entry of Object.values(file.projects)) {
    if (entry.id === projectId) return entry;
  }
  return null;
}

export class ProjectResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectResolutionError";
  }
}

/**
 * Resolve `--project` to a ProjectInfo. Accepts an absolute path, the current
 * cwd-relative path, or an existing project id. Ids must be safe directory
 * names — this is the guard against path traversal into `<home>/memories`.
 */
export async function resolveProjectArgument(home: string, value: string, cwd: string): Promise<ProjectInfo> {
  const trimmed = value.trim();
  if (trimmed === "") throw new ProjectResolutionError("empty --project value");
  if (PROJECT_ID_RE.test(trimmed)) {
    const entry = await findProjectById(home, trimmed);
    if (!entry) throw new ProjectResolutionError(`unknown project id "${trimmed}" (not in projects.json)`);
    const root = entry.paths[0];
    if (!root) throw new ProjectResolutionError(`project "${trimmed}" has no registered path`);
    return { id: entry.id, slug: entry.slug, name: entry.name, key: `id:${entry.id}`, root };
  }
  const resolvedPath = resolve(cwd, trimmed);
  const info = await detectProject(resolvedPath);
  await registerProject(home, info, "cli");
  return info;
}
