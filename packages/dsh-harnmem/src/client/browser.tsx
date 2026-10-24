import { useCallback, useState, type ReactNode } from 'react'
import type { MemoryFace } from './face'
import { PanelErrorBoundary } from './error-boundary'
import { absoluteTime, truncate } from './format'
import { useApi } from './hooks'
import { Tabs } from './ui'
import type { InspectOverviewPanel } from './types'
import {
  ContextView,
  DetailView,
  IndexView,
  MemoriesView,
  OverviewView,
  type Translate,
} from './views'

type TabId = 'overview' | 'memories' | 'index' | 'context'

interface TabSpec {
  id: TabId
  key: string
}

const TABS: readonly TabSpec[] = [
  { id: 'overview', key: 'tabOverview' },
  { id: 'memories', key: 'tabMemories' },
  { id: 'index', key: 'tabIndex' },
  { id: 'context', key: 'tabContext' },
]

/** Fallback translator used when the slot does not hand us a locale binding. */
const identityTranslate: Translate = (key, params) => {
  if (!params) return key
  let text = key
  for (const [name, value] of Object.entries(params)) {
    text = text.split(`{${name}}`).join(String(value))
  }
  return text
}

/** Props injected by the DSH `main` slot: locale binding + the memory API face. */
export interface MemoryPanelProps {
  t?: Translate
  face?: MemoryFace
}

/**
 * Left-column memory browser: a read-only window into the HarnMem store.
 *
 * Five screens share one shell: overview (home snapshot), memories list,
 * memory detail, verbatim index text and the injected-context preview. All
 * data goes through `face.request()` (host `/api/harnmem/*`); every view owns
 * its loading/empty/error pane and the shared error boundary keeps a broken
 * screen from taking the host layout down.
 */
export function MemoryPanel({ t, face }: MemoryPanelProps): ReactNode {
  const translate = t ?? identityTranslate
  const [tab, setTab] = useState<TabId>('overview')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [shard, setShard] = useState<string>('all')
  const [refreshToken, setRefreshToken] = useState(0)

  // One request for the header/overview; refreshes flow through `refreshToken`
  // so that open views refetch without remounting (local filters survive).
  const overview = useApi<InspectOverviewPanel>(face, 'overview.get', undefined, refreshToken)
  const refresh = useCallback((): void => setRefreshToken((value) => value + 1), [])

  const openMemory = useCallback((id: string): void => {
    setSelected(id)
    setTab('memories')
  }, [])

  const openShard = useCallback((next: string): void => {
    setShard(next)
    setSelected(undefined)
    setTab('memories')
  }, [])

  const selectTab = useCallback((id: TabId): void => {
    setSelected(undefined)
    setTab(id)
  }, [])

  const tabs = TABS.map((spec) => ({
    id: spec.id,
    label: translate(spec.key),
    badge:
      spec.id === 'memories' && overview.data?.totals
        ? String(overview.data.totals.records)
        : undefined,
  }))

  const body = ((): ReactNode => {
    if (selected) {
      return (
        <DetailView
          face={face}
          t={translate}
          refreshToken={refreshToken}
          id={selected}
          onBack={() => setSelected(undefined)}
          onOpenMemory={openMemory}
        />
      )
    }
    if (tab === 'memories') {
      return (
        <MemoriesView
          face={face}
          t={translate}
          refreshToken={refreshToken}
          shard={shard}
          onShardChange={setShard}
          shards={overview.data?.shards}
          onOpenMemory={openMemory}
        />
      )
    }
    if (tab === 'index') {
      return (
        <IndexView
          face={face}
          t={translate}
          refreshToken={refreshToken}
          shard={shard}
          onShardChange={setShard}
          shards={overview.data?.shards}
        />
      )
    }
    if (tab === 'context') {
      return <ContextView face={face} t={translate} refreshToken={refreshToken} onOpenMemory={openMemory} />
    }
    return (
      <OverviewView
        t={translate}
        overview={overview}
        onOpenShard={openShard}
        onOpenMemory={openMemory}
        onOpenIndex={() => selectTab('index')}
        onOpenContext={() => selectTab('context')}
      />
    )
  })()

  const cwd = face?.cwd?.()
  return (
    <div className="dshh-panel">
      <header className="dshh-header">
        <div className="dshh-header-main">
          <h2 className="dshh-title">{translate('title')}</h2>
          <div className="dshh-subtitle">{translate('subtitle')}</div>
        </div>
        <div className="dshh-header-actions">
          {cwd ? (
            <span className="dshh-cwd dshh-mono dshh-small" title={cwd}>
              {truncate(cwd, 40)}
            </span>
          ) : null}
          <button type="button" className="dshh-btn" onClick={refresh} disabled={!face}>
            {translate('refresh')}
          </button>
        </div>
      </header>

      <Tabs items={tabs} active={tab} onChange={selectTab} />

      <div className="dshh-body">
        <PanelErrorBoundary title={translate('error')} retryLabel={translate('retry')}>
          {body}
        </PanelErrorBoundary>
      </div>

      <footer className="dshh-footer dshh-muted dshh-small">
        <span>{`HarnMem · ${translate('readOnly')}`}</span>
        {overview.data ? (
          <span>{`${translate('generatedAtLabel')} ${absoluteTime(overview.data.generatedAt)}`}</span>
        ) : null}
      </footer>
    </div>
  )
}
