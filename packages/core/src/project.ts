/**
 * Project identity: the stable key that lets the same repo share memory across
 * harnesses, machines and worktrees. See docs/design/02-data-model.md §3.
 */
import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathExists, readJson, sha1Hex, writeJson } from "./util.js";

export interface ProjectInfo {
  /** Stable id: `<slug>-<sha1(key)[:10]>`. */
  id: string;
  slug: string;
  /** Human-readable name (repo basename or cwd basename). */
  name: string;
  /** Canonical identity key: `git:<normalized remote>` or `path:<normalized path>`. */
  key: string;
  root: string;
  gitRemote?: string;
}

export interface ProjectRegistryEntry {
  id: string;
  slug: string;
  name: string;
  paths: string[];
  harnesses: string[];
  created: number;
  updated: number;
}

export interface ProjectsFile {
  version: 1;
  projects: Record<string, ProjectRegistryEntry>;
}

export const EMPTY_PROJECTS: ProjectsFile = { version: 1, projects: {} };

const ASCII_SLUG_RE = /[^a-z0-9._-]+/g;

/** ASCII kebab-case; non-ASCII names collapse to "p". */
export function slugify(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(ASCII_SLUG_RE, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  if (!ascii) return "p";
  return ascii.slice(0, 40);
}

export function normalizePathKey(absPath: string): string {
  let p = resolve(absPath).replace(/\\/g, "/");
  if (process.platform === "win32") p = p.toLowerCase();
  p = p.replace(/\/+$/g, "");
  return p;
}

/** Normalize a git remote URL to `host/path` form. */
export function normalizeRemoteUrl(url: string): string {
  let s = url.trim();
  s = s.replace(/^git\+/, "");
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  s = s.replace(/^([^/:]+):(\d+)\//, "$1/");
  s = s.replace(/^([^/:]+):(?!\/)/, "$1/"); // scp-like host:path
  s = s.replace(/\/+/g, "/").replace(/\/+$/, "");
  s = s.replace(/\.git$/i, "");
  const slash = s.indexOf("/");
  if (slash > 0) s = `${s.slice(0, slash).toLowerCase()}${s.slice(slash)}`;
  return s;
}

async function findGitRepoRoot(start: string): Promise<string | null> {
  let dir = resolve(start);
  for (;;) {
    if (await pathExists(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function resolveGitDir(repoRoot: string): Promise<string | null> {
  const dotGit = join(repoRoot, ".git");
  try {
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) return dotGit;
  } catch {
    return null;
  }
  try {
    const raw = await fs.readFile(dotGit, "utf8");
    const m = /^gitdir:\s*(.+)$/m.exec(raw);
    if (!m) return null;
    const p = m[1] as string;
    return resolve(repoRoot, p.trim());
  } catch {
    return null;
  }
}

async function readRemotes(gitDir: string): Promise<Map<string, string>> {
  const remotes = new Map<string, string>();
  try {
    const config = await fs.readFile(join(gitDir, "config"), "utf8");
    let name: string | null = null;
    let inRemote = false;
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[(.+?)\]\s*$/.exec(line);
      if (section) {
        const header = (section[1] ?? "").trim();
        const m = /^remote\s+"(.+)"$/.exec(header);
        inRemote = Boolean(m);
        name = m ? (m[1] as string) : null;
        continue;
      }
      if (!inRemote || !name) continue;
      const kv = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (kv && !remotes.has(name)) remotes.set(name, kv[1] as string);
    }
  } catch {
    // no config: path fallback
  }
  return remotes;
}

/**
 * Detect the project a cwd belongs to. Git remote wins over path so that
 * worktrees, moved repos and multiple clones share one project.
 */
export async function detectProject(cwd: string): Promise<ProjectInfo> {
  const absCwd = resolve(cwd);
  const repoRoot = await findGitRepoRoot(absCwd);
  if (repoRoot) {
    const gitDir = await resolveGitDir(repoRoot);
    if (gitDir) {
      const remotes = await readRemotes(gitDir);
      const url = remotes.get("origin") ?? [...remotes.values()][0];
      if (url) {
        const normalized = normalizeRemoteUrl(url);
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

export function projectsFile(home: string): string {
  return join(home, "projects.json");
}

export async function loadProjects(home: string): Promise<ProjectsFile> {
  const file = projectsFile(home);
  const parsed = await readJson<Partial<ProjectsFile>>(file, EMPTY_PROJECTS);
  if (!parsed || typeof parsed !== "object" || !parsed.projects) return { version: 1, projects: {} };
  return { version: 1, projects: parsed.projects };
}

export async function registerProject(
  home: string,
  info: ProjectInfo,
  harness?: string,
  now: number = Date.now(),
): Promise<void> {
  const registry = await loadProjects(home);
  const existing = registry.projects[info.key];
  const entry: ProjectRegistryEntry = existing ?? {
    id: info.id,
    slug: info.slug,
    name: info.name,
    paths: [],
    harnesses: [],
    created: now,
    updated: now,
  };
  entry.name = info.name || entry.name;
  if (!entry.paths.includes(info.root)) entry.paths.push(info.root);
  if (harness && !entry.harnesses.includes(harness)) entry.harnesses.push(harness);
  entry.updated = now;
  registry.projects[info.key] = entry;
  await writeJson(projectsFile(home), registry);
}

/** Find a registered project by id, name or path. */
export async function findProject(home: string, query: string): Promise<ProjectRegistryEntry | null> {
  const registry = await loadProjects(home);
  const q = query.trim();
  if (!q) return null;
  for (const entry of Object.values(registry.projects)) {
    if (entry.id === q || entry.id.startsWith(q)) return entry;
    if (entry.slug === q || entry.name === q) return entry;
    if (entry.paths.some((p) => normalizePathKey(p) === normalizePathKey(q))) return entry;
  }
  return null;
}
