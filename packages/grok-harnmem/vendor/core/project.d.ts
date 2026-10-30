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
export declare const EMPTY_PROJECTS: ProjectsFile;
/** ASCII kebab-case; non-ASCII names collapse to "p". */
export declare function slugify(name: string): string;
export declare function normalizePathKey(absPath: string): string;
/** Normalize a git remote URL to `host/path` form. */
export declare function normalizeRemoteUrl(url: string): string;
/**
 * Detect the project a cwd belongs to. Git remote wins over path so that
 * worktrees, moved repos and multiple clones share one project.
 */
export declare function detectProject(cwd: string): Promise<ProjectInfo>;
export declare function projectsFile(home: string): string;
export declare function loadProjects(home: string): Promise<ProjectsFile>;
export declare function registerProject(home: string, info: ProjectInfo, harness?: string, now?: number): Promise<void>;
/** Find a registered project by id, name or path. */
export declare function findProject(home: string, query: string): Promise<ProjectRegistryEntry | null>;
//# sourceMappingURL=project.d.ts.map