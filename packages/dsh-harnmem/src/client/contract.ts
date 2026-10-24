import type { ReactNode } from 'react'

/**
 * Minimal local typings for the DSH web client plugin surface.
 *
 * The production types live in `@deepseek-ai/dsh-client-ui-slots` &
 * `@deepseek-ai/dsh-client-ui-layout`, which are only resolvable inside the
 * DSH monorepo. Keeping a local structural contract keeps the browser bundle
 * decoupled from rc-version drift; the shapes below mirror the published
 * declaration files (react 19 + DSH 0.1.5-rc.3).
 */

/** Anything usable as a React element from a slot component. */
export type SlotNode = ReactNode

/** Services exposed on the client plugin context. */
export interface ClientLocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): unknown
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
}

export interface ClientSlotOptions {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string | (() => string)
  locale?: string
  inject?: () => Record<string, unknown>
}

export interface ClientSlotsService {
  register(options: ClientSlotOptions, component: (props: never) => SlotNode): () => void
  inject(slot: string, callback: () => unknown): unknown
}

export interface ClientSessionSnapshot {
  id?: string
  cwd?: string
  updatedAt?: number
  running?: boolean
  archived?: boolean
}

export interface ClientSessionsService {
  list?: {
    getSnapshot(): { byId?: Record<string, ClientSessionSnapshot>; ids?: readonly string[] }
  }
  getSnapshot?: () => { byId?: Record<string, ClientSessionSnapshot> }
}

export interface ClientEffect {
  (factory: () => unknown, label?: string): unknown
}

/** The cordis client context entry point receives. */
export interface ClientContext {
  slots: ClientSlotsService
  locale: ClientLocaleService
  get(name: string): unknown
  effect?: ClientEffect
}

/** Props every `sidebar.panellist` occupant receives (DSH `SidebarPanelIconOwnerProps`). */
export interface PanelIconProps {
  size?: number
  active?: boolean
}

/** Resolves the working directory of the most relevant session, if any. */
export function activeCwd(ctx: ClientContext): string | undefined {
  const sessions = ctx.get('sessions') as ClientSessionsService | undefined
  const snapshot = sessions?.list?.getSnapshot?.() ?? sessions?.getSnapshot?.()
  const byId = snapshot?.byId
  if (!byId) return undefined
  let best: { cwd?: string; score: number } | undefined
  for (const id of Object.keys(byId)) {
    const session = byId[id]
    if (!session?.cwd) continue
    const score = (session.running ? 1_000_000_000_000 : 0) + (session.updatedAt ?? 0)
    if (!best || score > best.score) best = { cwd: session.cwd, score }
  }
  return best?.cwd
}
