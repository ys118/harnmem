import type { ClientContext } from './contract'
import { activeCwd } from './contract'
import { MemoryPanel } from './browser'
import { createFace } from './face'
import { dictionaries, NS, PANEL_ID } from './locales'
import { MemoryPanelIcon } from './panel-icon'
import { injectPanelStyles } from './styles'

/** Plugin id: must match the `id` handed to `window.__ModuleLoader__.load`. */
export const name = 'dsh-harnmem'

/** Client-side service dependencies (package ids, resolved by the web loader). */
export const inject = ['slots', 'locale', 'sessions']

/**
 * Internal pieces re-exported for SSR regression tests (and hosts that want to
 * reuse the same fallback chrome / markdown renderer). The DSH module loader
 * only reads `name`, `inject` and `apply`; these facade exports are inert.
 */
export { PanelErrorBoundary, PanelErrorFallback, errorMessage } from './error-boundary'
export { Markdown } from './markdown'
export { ContextView, DetailView, IndexView, MemoriesView, OverviewView } from './views'

/**
 * Registers the sidebar entry and the main panel.
 *
 * A `sidebar.panellist` row and a `main` keyed entry are two halves of one
 * panel: the row's `id` is the layout's `MainPanelId`, so both registrations
 * must use the same value or selecting the row throws.
 */
export function apply(ctx: ClientContext): void {
  injectPanelStyles()

  ctx.effect?.(() => ctx.locale.register(NS, dictionaries), 'dsh-harnmem: locale')
  const t = ctx.locale.bind(NS)

  const face = createFace(() => activeCwd(ctx))

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ face }) },
      MemoryPanel as never,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 60,
        label: () => t('panel'),
        locale: NS,
      },
      MemoryPanelIcon as never,
    ),
  )
}
