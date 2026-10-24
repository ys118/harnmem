/**
 * Hand-written mirror of the read-only inspection projection exposed by
 * `@harnmem/core` `inspect.ts` (the data-plane SSOT) and served by the host
 * half under `/api/harnmem/*`.
 *
 * The browser bundle must not import `@harnmem/core` (it is a Node package:
 * `node:fs`, `node:path`, `Buffer`). Keeping the shapes here also decouples the
 * panel from package versions drifting across the DSH web loader boundary.
 *
 * `InspectOverviewPanel` extends the shared overview with the *optional*
 * engine-level statistics (`health` / `extraction`) that `HarnMem.stats()`
 * reports. The host panel API currently ships the inspector projection only, so
 * the panel renders those sections defensively when the host eventually adds
 * them and falls back to inspector-derived health otherwise.
 */

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

export type MemoryCategory =
  | 'profile'
  | 'preference'
  | 'decision'
  | 'convention'
  | 'lesson'
  | 'pitfall'
  | 'state'
  | 'external'
  | (string & {})

export type MemoryScope = 'user' | 'project'

export type MemoryStatus = 'active' | 'superseded' | 'archived' | 'dropped'

/** One diagnostics/warning row surfaced by the inspector. */
export interface InspectIssue {
  level: 'warn' | 'error'
  code: string
  message: string
}

/** A record file that failed to parse (the rest of the shard still renders). */
export interface InspectFileError {
  file: string
  message: string
}

/** Per-shard aggregate shown in the overview. */
export interface InspectShard {
  /** Shard name: `"user"` or the project id (`<slug>-<hash>`). */
  name: string
  scope: MemoryScope
  project: string | null
  projectName: string | null
  label: string
  total: number
  active: number
  superseded: number
  archived: number
  pinned: number
  bytes: number
  tokens: number
  indexBytes: number
  lastUpdated: number | null
}

/** List-row projection of one memory (no body). */
export interface InspectRow {
  id: string
  type: MemoryType
  category: MemoryCategory | null
  scope: MemoryScope
  project: string | null
  projectName: string | null
  title: string
  description: string
  preview: string
  tags: string[]
  entities: string[]
  importance: number
  confidence: number
  pinned: boolean
  status: MemoryStatus
  created: number
  updated: number
  lastUsed: number | null
  usedCount: number
  validFrom: number
  validTo: number | null
  supersededBy: string | null
  links: string[]
  supersedes: string[]
  evidence: number
  bytes: number
  tokens: number
  harness: string
}

/** Full projection of one memory, including the on-disk text. */
export interface InspectMemory extends InspectRow {
  /** Markdown body (frontmatter stripped). */
  content: string
  /** Parsed frontmatter as stored. */
  frontmatter: Record<string, unknown>
  /** Verbatim file contents. */
  raw: string
  /** Path relative to the HarnMem home, POSIX separators. */
  filePath: string
  /** Ids of records whose `links` point here (cross-shard). */
  backlinks: string[]
  /** Older versions, newest first, when `history` was requested. */
  history?: InspectRow[]
}

/** Project registry entry merged with on-disk shard facts. */
export interface InspectProject {
  id: string
  slug: string
  name: string
  paths: string[]
  harnesses: string[]
  registered: boolean
  shards: string[]
  total: number
  pinned: number
  lastUpdated: number | null
}

/** Index health reported by the overview. */
export interface InspectIndexStatus {
  manifest: {
    seq: number
    builtAt: number
    bytes: number
    shards: Array<{ name: string; docs: number }>
  } | null
  /** Current store sequence (`state/seq.json`). */
  seq: number
  /** Manifest sequence is behind the store sequence. */
  stale: boolean
  files: Array<{
    shard: string
    path: string
    bytes: number
    exists: boolean
    docs: number | null
    records: number
  }>
}

/** The injected hot-index block, replayed from disk. */
export interface InspectContext {
  cwd: string | null
  projectId: string | null
  projectName: string | null
  shards: string[]
  text: string
  ids: string[]
  tokensEstimate: number
  bytes: number
  budgetTokens: number
  hotEntries: number
  atBudget: boolean
}

/** Whole-home snapshot for the overview screen. */
export interface InspectOverview {
  version: 1
  home: string
  generatedAt: number
  project: string | null
  projectName: string | null
  totals: {
    records: number
    active: number
    superseded: number
    archived: number
    pinned: number
    bytes: number
    tokens: number
    shards: number
    projects: number
    trash: number
    digests: number
  }
  byType: Record<string, number>
  byStatus: Record<string, number>
  byHarness: Record<string, number>
  budget: { injectTokens: number; hotEntries: number; maxPinned: number }
  context: InspectContext
  shards: InspectShard[]
  projects: InspectProject[]
  index: InspectIndexStatus
  issues: InspectIssue[]
  fileErrors: InspectFileError[]
}

/**
 * Engine-level statistics that `HarnMem.stats()` reports for the health screen.
 * Not part of `InspectOverview` today; rendered only when a host supplies them.
 */
export interface PanelHealth {
  overBudget: boolean
  duplicateCandidates: number
  orphans: number
  lastConsolidate: number | null
}

/** Session-end extraction counters (pending/failed plus skip-reason buckets). */
export interface PanelExtraction {
  pending: number
  failed: number
  skipReasons: Record<string, number>
}

/** Overview plus optional engine statistics. */
export interface InspectOverviewPanel extends InspectOverview {
  health?: PanelHealth
  extraction?: PanelExtraction
}

/** Result of `memories.list`. */
export interface InspectList {
  shard: string
  label: string
  total: number
  rows: InspectRow[]
  generatedAt: number
}

/** Result of `index.read`. */
export interface InspectIndexText {
  text: string
  bytes: number
  parts: Array<{ shard: string; label: string; path: string; text: string; bytes: number }>
  generatedAt: number
}

/** Panel API routes (host half `src/panel-api.ts`, dotted tails). */
export const API_ROUTES = [
  'overview.get',
  'memories.list',
  'memory.read',
  'context.preview',
  'index.read',
  'projects.list',
] as const

export type ApiRoute = (typeof API_ROUTES)[number]

/** `"all"` or a concrete shard name; used by the list/index screens. */
export const ALL_SHARDS = 'all'
