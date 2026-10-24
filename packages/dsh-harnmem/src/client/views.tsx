import { useMemo, useState, type ReactNode } from 'react'
import type { MemoryFace } from './face'
import type { ApiResult } from './hooks'
import { useApi, useNow } from './hooks'
import { absoluteTime, formatBytes, formatCount, relativeTime, truncate } from './format'
import { Markdown } from './markdown'
import {
  Badge,
  Chips,
  CopyButton,
  EmptyState,
  ErrorState,
  FilterSelect,
  KeyValue,
  LoadingState,
  Meter,
  Section,
  Stat,
  StatGrid,
  Tabs,
  type Tone,
} from './ui'
import type {
  InspectContext,
  InspectIndexText,
  InspectList,
  InspectMemory,
  InspectOverviewPanel,
  InspectProject,
  InspectRow,
  InspectShard,
  MemoryStatus,
  MemoryType,
} from './types'

/** Translation function shape shared with the locale service. */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** Props every view receives. */
export interface ViewProps {
  face: MemoryFace | undefined
  t: Translate
  /** Bumped by the panel's refresh button to refetch without remounting. */
  refreshToken: number
}

const TYPE_KEYS: Record<string, string> = {
  user: 'typeUser',
  feedback: 'typeFeedback',
  project: 'typeProject',
  reference: 'typeReference',
}

const STATUS_KEYS: Record<string, string> = {
  active: 'statusActive',
  superseded: 'statusSuperseded',
  archived: 'statusArchived',
  dropped: 'statusDropped',
}

function typeLabel(t: Translate, type: string): string {
  return t(TYPE_KEYS[type] ?? 'typeUser')
}

function statusLabel(t: Translate, status: string): string {
  return t(STATUS_KEYS[status] ?? 'statusActive')
}

function statusTone(status: MemoryStatus | string): Tone {
  if (status === 'active') return 'success'
  if (status === 'superseded') return 'warn'
  return 'neutral'
}

function typeTone(type: MemoryType | string): Tone {
  if (type === 'feedback') return 'warn'
  if (type === 'project') return 'accent'
  if (type === 'reference') return 'success'
  return 'neutral'
}

/** Shared loading / error gate for per-view requests. */
function gate(
  t: Translate,
  state: { status: string; error: string | undefined; reload: () => void },
  retryKey: string,
): ReactNode | undefined {
  if (state.status === 'loading') return <LoadingState label={t('loading')} />
  if (state.status === 'error') {
    return <ErrorState title={t('error')} message={state.error ?? ''} retryLabel={t(retryKey)} onRetry={state.reload} />
  }
  return undefined
}

/** Converts `"all"` or a shard name into filter options. */
export function shardOptions(
  t: Translate,
  shards: readonly InspectShard[] | undefined,
): Array<{ value: string; label: string }> {
  const options = [
    { value: 'all', label: t('all') },
    { value: 'user', label: typeLabel(t, 'user') },
  ]
  for (const shard of shards ?? []) {
    options.push({ value: shard.name, label: shard.label || shard.name })
  }
  return options
}

/* ------------------------------------------------------------------ overview */

export interface OverviewViewProps {
  t: Translate
  overview: ApiResult<InspectOverviewPanel>
  onOpenShard: (shard: string) => void
  onOpenMemory: (id: string) => void
  onOpenIndex: () => void
  onOpenContext: () => void
}

/** Home snapshot: totals, project, budgets, index health, shards, projects. */
export function OverviewView({
  t,
  overview,
  onOpenShard,
  onOpenIndex,
  onOpenContext,
}: OverviewViewProps): ReactNode {
  const data = overview.data
  if (overview.status === 'loading') return <LoadingState label={t('loading')} />
  if (overview.status === 'error') {
    return (
      <ErrorState
        title={t('error')}
        message={overview.error ?? ''}
        retryLabel={t('retry')}
        onRetry={overview.reload}
      />
    )
  }
  if (!data) return <EmptyState title={t('empty')} hint={t('noProject')} />

  const totals = data.totals
  const budget = data.budget
  const context = data.context
  const index = data.index
  const issues = data.issues ?? []
  const fileErrors = data.fileErrors ?? []
  const indexFiles = index?.files ?? []
  const indexBytes = indexFiles.reduce((sum, file) => sum + (file.bytes ?? 0), 0)

  return (
    <div className="dshh-overview">
      <Section title={t('totals')}>
        <StatGrid>
          <Stat label={t('records')} value={formatCount(totals?.records)} />
          <Stat label={t('active')} value={formatCount(totals?.active)} tone="success" />
          <Stat label={t('superseded')} value={formatCount(totals?.superseded)} />
          <Stat label={t('archived')} value={formatCount(totals?.archived)} />
          <Stat label={t('pinned')} value={formatCount(totals?.pinned)} />
          <Stat label={t('bytes')} value={formatBytes(totals?.bytes)} />
          <Stat label={t('tokens')} value={formatCount(totals?.tokens)} />
          <Stat label={t('shards')} value={formatCount(totals?.shards)} />
          <Stat label={t('projects')} value={formatCount(totals?.projects)} />
          <Stat label={t('trash')} value={formatCount(totals?.trash)} />
          <Stat label={t('digests')} value={formatCount(totals?.digests)} />
        </StatGrid>
      </Section>

      <Section title={t('home')}>
        <KeyValue
          rows={[
            { label: t('home'), value: data.home, mono: true },
            {
              label: t('project'),
              value: data.projectName ?? data.project ?? t('noProject'),
            },
            { label: t('generatedAtLabel'), value: absoluteTime(data.generatedAt) },
          ]}
        />
      </Section>

      <Section
        title={t('budget')}
        extra={
          <button type="button" className="dshh-btn dshh-btn-small" onClick={onOpenContext}>
            {t('tabContext')}
          </button>
        }
      >
        <Meter
          label={t('budgetUsed')}
          value={context?.tokensEstimate ?? 0}
          max={context?.budgetTokens ?? budget?.injectTokens ?? 0}
          text={`${formatCount(context?.tokensEstimate)} / ${formatCount(context?.budgetTokens ?? budget?.injectTokens)}`}
          over={context?.atBudget}
        />
        <StatGrid>
          <Stat label={t('hotEntries')} value={formatCount(context?.hotEntries ?? budget?.hotEntries)} />
          <Stat label={t('injectTokens')} value={formatCount(budget?.injectTokens)} />
          <Stat label={t('maxPinned')} value={formatCount(budget?.maxPinned)} />
          <Stat
            label={t('contextIds')}
            value={formatCount(context?.ids?.length)}
            hint={context?.atBudget ? t('atBudget') : t('withinBudget')}
            tone={context?.atBudget ? 'warn' : undefined}
          />
        </StatGrid>
      </Section>

      {data.health || data.extraction ? (
        <Section title={t('health')}>
          <StatGrid>
            {data.health ? (
              <>
                <Stat
                  label={t('overBudget')}
                  value={data.health.overBudget ? t('atBudget') : t('withinBudget')}
                  tone={data.health.overBudget ? 'warn' : 'success'}
                />
                <Stat label={t('duplicateCandidates')} value={formatCount(data.health.duplicateCandidates)} />
                <Stat label={t('orphans')} value={formatCount(data.health.orphans)} />
                <Stat label={t('lastConsolidate')} value={relativeTime(data.health.lastConsolidate, Date.now(), t)} />
              </>
            ) : null}
            {data.extraction ? (
              <>
                <Stat label={t('pending')} value={formatCount(data.extraction.pending)} />
                <Stat
                  label={t('failed')}
                  value={formatCount(data.extraction.failed)}
                  tone={data.extraction.failed > 0 ? 'danger' : undefined}
                />
              </>
            ) : null}
          </StatGrid>
        </Section>
      ) : null}

      <Section
        title={t('indexHealth')}
        extra={
          <button type="button" className="dshh-btn dshh-btn-small" onClick={onOpenIndex}>
            {t('tabIndex')}
          </button>
        }
      >
        <KeyValue
          rows={[
            { label: t('seq'), value: `${index?.seq ?? '—'}`, mono: true },
            {
              label: t('status'),
              value: index?.stale ? (
                <Badge tone="warn">{t('stale')}</Badge>
              ) : (
                <Badge tone="success">{t('fresh')}</Badge>
              ),
            },
            {
              label: t('manifest'),
              value: index?.manifest
                ? `${absoluteTime(index.manifest.builtAt)} · ${formatBytes(index.manifest.bytes)}`
                : t('none'),
            },
            { label: t('files'), value: String(indexFiles.length) },
            { label: t('indexBytes'), value: formatBytes(indexBytes) },
          ]}
        />
      </Section>

      {Object.keys(data.byType ?? {}).length > 0 ? (
        <Section title={t('byType')}>
          <div className="dshh-chip-grid">
            {Object.entries(data.byType).map(([key, count]) => (
              <Badge key={key} tone={typeTone(key)}>
                {`${typeLabel(t, key)} ${formatCount(count)}`}
              </Badge>
            ))}
          </div>
        </Section>
      ) : null}

      {Object.keys(data.byHarness ?? {}).length > 0 ? (
        <Section title={t('byHarness')}>
          <div className="dshh-chip-grid">
            {Object.entries(data.byHarness).map(([key, count]) => (
              <Badge key={key}>{`${key} ${formatCount(count)}`}</Badge>
            ))}
          </div>
        </Section>
      ) : null}

      <Section title={t('shardTable')}>
        {data.shards.length === 0 ? (
          <p className="dshh-muted">{t('empty')}</p>
        ) : (
          <table className="dshh-table">
            <thead>
              <tr>
                <th>{t('shardName')}</th>
                <th>{t('shardTotal')}</th>
                <th>{t('shardActive')}</th>
                <th>{t('pinned')}</th>
                <th>{t('bytes')}</th>
                <th>{t('shardUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {data.shards.map((shard) => (
                <tr key={shard.name}>
                  <td>
                    <button type="button" className="dshh-link-button" onClick={() => onOpenShard(shard.name)}>
                      {shard.label || shard.name}
                    </button>
                    <div className="dshh-muted dshh-small">{shard.name}</div>
                  </td>
                  <td>{formatCount(shard.total)}</td>
                  <td>{formatCount(shard.active)}</td>
                  <td>{formatCount(shard.pinned)}</td>
                  <td>{formatBytes(shard.bytes)}</td>
                  <td>{relativeTime(shard.lastUpdated, Date.now(), t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title={t('projects')}>
        {data.projects.length === 0 ? (
          <p className="dshh-muted">{t('noProject')}</p>
        ) : (
          <div className="dshh-project-list">
            {data.projects.map((project) => (
              <ProjectCard key={project.id} project={project} t={t} onOpenShard={onOpenShard} />
            ))}
          </div>
        )}
      </Section>

      <Section title={t('issues')}>
        {issues.length === 0 && fileErrors.length === 0 ? (
          <p className="dshh-muted">{t('noIssues')}</p>
        ) : (
          <ul className="dshh-issue-list">
            {issues.map((issue, issueIndex) => (
              <li key={`${issue.code}-${issueIndex}`} className="dshh-issue">
                <Badge tone={issue.level === 'error' ? 'danger' : 'warn'}>{issue.level}</Badge>
                <span className="dshh-issue-code dshh-mono">{issue.code}</span>
                <span>{issue.message}</span>
              </li>
            ))}
            {fileErrors.map((fileError, fileIndex) => (
              <li key={`file-${fileIndex}`} className="dshh-issue">
                <Badge tone="danger">{t('fileErrors')}</Badge>
                <span className="dshh-mono">{fileError.file}</span>
                <span>{fileError.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function ProjectCard({
  project,
  t,
  onOpenShard,
}: {
  project: InspectProject
  t: Translate
  onOpenShard: (shard: string) => void
}): ReactNode {
  const shard = project.shards[0] ?? project.id
  return (
    <div className="dshh-card dshh-project">
      <div className="dshh-project-head">
        <button type="button" className="dshh-link-button dshh-project-name" onClick={() => onOpenShard(shard)}>
          {project.name || project.slug || project.id}
        </button>
        {project.registered ? <Badge tone="success">registered</Badge> : <Badge>{t('none')}</Badge>}
      </div>
      <div className="dshh-muted dshh-small dshh-mono">{project.id}</div>
      {project.paths.length > 0 ? (
        <div className="dshh-project-paths">
          {project.paths.map((path) => (
            <span key={path} className="dshh-mono dshh-small">
              {truncate(path, 72)}
            </span>
          ))}
        </div>
      ) : null}
      <div className="dshh-project-meta dshh-muted dshh-small">
        {`${t('shardTotal')} ${formatCount(project.total)} · ${t('pinned')} ${formatCount(project.pinned)} · ${t('updated')} ${relativeTime(project.lastUpdated, Date.now(), t)}`}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- memories list */

export interface MemoriesViewProps extends ViewProps {
  shard: string
  onShardChange: (shard: string) => void
  shards: readonly InspectShard[] | undefined
  onOpenMemory: (id: string) => void
}

/** Filterable list of memories for one shard (or all shards). */
export function MemoriesView({
  face,
  t,
  refreshToken,
  shard,
  onShardChange,
  shards,
  onOpenMemory,
}: MemoriesViewProps): ReactNode {
  const now = useNow()
  const [type, setType] = useState('all')
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useState('')
  const result = useApi<InspectList>(
    face,
    'memories.list',
    { shard, includeInactive: true },
    refreshToken,
  )

  const rows = useMemo(() => {
    const all = result.data?.rows ?? []
    const needle = query.trim().toLowerCase()
    return all.filter((row) => {
      if (type !== 'all' && row.type !== type) return false
      if (status !== 'all' && row.status !== status) return false
      if (!needle) return true
      return (
        row.title.toLowerCase().includes(needle)
        || row.description.toLowerCase().includes(needle)
        || row.preview.toLowerCase().includes(needle)
        || row.tags.some((tag) => tag.toLowerCase().includes(needle))
        || row.id.toLowerCase().includes(needle)
      )
    })
  }, [result.data, type, status, query])

  const loading = gate(t, result, 'retry')
  if (loading) return loading
  if (!result.data) return <EmptyState title={t('empty')} />

  return (
    <div className="dshh-list-view">
      <div className="dshh-toolbar">
        <FilterSelect
          label={t('filterShard')}
          value={shard}
          options={shardOptions(t, shards)}
          onChange={onShardChange}
        />
        <FilterSelect
          label={t('filterType')}
          value={type}
          options={[
            { value: 'all', label: t('all') },
            { value: 'user', label: t('typeUser') },
            { value: 'feedback', label: t('typeFeedback') },
            { value: 'project', label: t('typeProject') },
            { value: 'reference', label: t('typeReference') },
          ]}
          onChange={setType}
        />
        <FilterSelect
          label={t('filterStatus')}
          value={status}
          options={[
            { value: 'all', label: t('all') },
            { value: 'active', label: t('statusActive') },
            { value: 'superseded', label: t('statusSuperseded') },
            { value: 'archived', label: t('statusArchived') },
          ]}
          onChange={setStatus}
        />
        <label className="dshh-filter dshh-filter-grow">
          <span className="dshh-filter-label">{t('search')}</span>
          <input
            className="dshh-input"
            type="search"
            value={query}
            placeholder={t('searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <div className="dshh-list-meta dshh-muted">
        {t('loadedRows', { shown: rows.length, total: result.data.total })}
        {result.data.label ? ` · ${result.data.label}` : ''}
      </div>

      {rows.length === 0 ? (
        <EmptyState title={query || type !== 'all' || status !== 'all' ? t('noMatch') : t('empty')} />
      ) : (
        <div className="dshh-rows">
          {rows.map((row) => (
            <MemoryRow key={`${row.scope}:${row.id}`} row={row} t={t} now={now} onOpen={onOpenMemory} />
          ))}
        </div>
      )}
    </div>
  )
}

function MemoryRow({
  row,
  t,
  now,
  onOpen,
}: {
  row: InspectRow
  t: Translate
  now: number
  onOpen: (id: string) => void
}): ReactNode {
  const description = row.description || row.preview
  return (
    <button type="button" className="dshh-row" onClick={() => onOpen(row.id)}>
      <div className="dshh-row-head">
        <span className="dshh-row-title">{row.title}</span>
        <span className="dshh-row-badges">
          {row.pinned ? <Badge tone="accent">{t('pinned')}</Badge> : null}
          <Badge tone={typeTone(row.type)}>{typeLabel(t, row.type)}</Badge>
          <Badge tone={statusTone(row.status)}>{statusLabel(t, row.status)}</Badge>
        </span>
      </div>
      {description ? <div className="dshh-row-desc">{description}</div> : null}
      <div className="dshh-row-meta dshh-muted">
        <span className="dshh-mono">{row.id}</span>
        <span>{`${t('updated')} ${relativeTime(row.updated, now, t)}`}</span>
        <span>{`${t('importance')} ${row.importance}`}</span>
        <span>{`${formatCount(row.tokens)} ${t('tokens')}`}</span>
      </div>
    </button>
  )
}

/* ----------------------------------------------------------------- memory detail */

export interface DetailViewProps extends ViewProps {
  id: string
  onBack: () => void
  onOpenMemory: (id: string) => void
}

/** Full projection of one memory, including body markdown and raw file text. */
export function DetailView({ face, t, refreshToken, id, onBack, onOpenMemory }: DetailViewProps): ReactNode {
  const now = useNow()
  const result = useApi<InspectMemory | null>(face, 'memory.read', { id, history: true }, refreshToken)

  const back = (
    <button type="button" className="dshh-btn dshh-btn-small" onClick={onBack}>
      {`← ${t('back')}`}
    </button>
  )

  const loading = gate(t, result, 'retry')
  if (loading) {
    return (
      <div className="dshh-detail">
        <div className="dshh-detail-head">{back}</div>
        {loading}
      </div>
    )
  }
  if (!result.data) {
    return (
      <div className="dshh-detail">
        <div className="dshh-detail-head">{back}</div>
        <EmptyState title={t('notFound')} hint={id} />
      </div>
    )
  }

  const memory = result.data
  const raw = memory.raw ?? ''
  const frontmatter = JSON.stringify(memory.frontmatter ?? {}, null, 2)

  return (
    <div className="dshh-detail">
      <div className="dshh-detail-head">
        {back}
        <CopyButton text={raw} label={t('copy')} copiedLabel={t('copied')} />
      </div>
      <h3 className="dshh-detail-title">{memory.title}</h3>
      <div className="dshh-row-badges">
        {memory.pinned ? <Badge tone="accent">{t('pinned')}</Badge> : null}
        <Badge tone={typeTone(memory.type)}>{typeLabel(t, memory.type)}</Badge>
        <Badge tone={statusTone(memory.status)}>{statusLabel(t, memory.status)}</Badge>
        {memory.category ? <Badge>{memory.category}</Badge> : null}
      </div>

      <Section title={t('detailFromList')}>
        <KeyValue
          rows={[
            { label: t('id'), value: memory.id, mono: true },
            { label: t('scope'), value: memory.scope },
            { label: t('project'), value: memory.projectName ?? memory.project ?? t('noProject') },
            { label: t('harness'), value: memory.harness || t('none') },
            { label: t('importance'), value: String(memory.importance) },
            { label: t('confidence'), value: String(memory.confidence) },
            { label: t('created'), value: absoluteTime(memory.created) },
            { label: t('updated'), value: absoluteTime(memory.updated) },
            { label: t('lastUsed'), value: memory.lastUsed ? absoluteTime(memory.lastUsed) : t('none') },
            { label: t('usedCount'), value: String(memory.usedCount) },
            { label: t('validFrom'), value: absoluteTime(memory.validFrom) },
            { label: t('validTo'), value: memory.validTo ? absoluteTime(memory.validTo) : t('none') },
            { label: t('evidence'), value: String(memory.evidence) },
            { label: t('filePath'), value: memory.filePath, mono: true },
            { label: t('bytes'), value: `${formatBytes(memory.bytes)} · ${formatCount(memory.tokens)} ${t('tokens')}` },
          ]}
        />
      </Section>

      <Section title={t('tags')}>
        <Chips items={memory.tags ?? []} emptyLabel={t('none')} />
      </Section>
      <Section title={t('entities')}>
        <Chips items={memory.entities ?? []} emptyLabel={t('none')} />
      </Section>
      <Section title={t('links')}>
        <Chips items={memory.links ?? []} emptyLabel={t('none')} onSelect={onOpenMemory} />
      </Section>
      <Section title={t('backlinks')}>
        <Chips items={memory.backlinks ?? []} emptyLabel={t('none')} onSelect={onOpenMemory} />
      </Section>
      <Section title={t('supersedes')}>
        <Chips items={memory.supersedes ?? []} emptyLabel={t('none')} onSelect={onOpenMemory} />
      </Section>
      {memory.supersededBy ? (
        <Section title={t('supersededBy')}>
          <Chips items={[memory.supersededBy]} onSelect={onOpenMemory} />
        </Section>
      ) : null}

      <Section title={t('content')}>
        <Markdown text={memory.content ?? ''} className="dshh-detail-body" />
      </Section>

      <Section title={t('raw')}>
        <details className="dshh-details">
          <summary>{`${t('raw')} · ${formatBytes(memory.bytes)}`}</summary>
          <pre className="dshh-pre dshh-pre-wrap">{raw}</pre>
        </details>
        <details className="dshh-details">
          <summary>{t('frontmatter')}</summary>
          <pre className="dshh-pre dshh-pre-wrap">{frontmatter}</pre>
        </details>
      </Section>

      {memory.history && memory.history.length > 0 ? (
        <Section title={t('history')}>
          <div className="dshh-rows">
            {memory.history.map((row, index) => (
              <MemoryRow key={`${row.id}-${index}`} row={row} t={t} now={now} onOpen={onOpenMemory} />
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- index raw */

export interface IndexViewProps extends ViewProps {
  shard: string
  onShardChange: (shard: string) => void
  shards: readonly InspectShard[] | undefined
}

/** Verbatim `MEMORY.md` shard index text (the injected hot index, read-only). */
export function IndexView({ face, t, refreshToken, shard, onShardChange, shards }: IndexViewProps): ReactNode {
  const result = useApi<InspectIndexText>(face, 'index.read', { shard }, refreshToken)
  const [part, setPart] = useState('all')

  const loading = gate(t, result, 'retry')
  if (loading) return loading
  const data = result.data
  if (!data) return <EmptyState title={t('emptyIndex')} hint={t('indexHint')} />

  const parts = data.parts ?? []
  const selected = part === 'all' ? undefined : parts.find((item) => item.shard === part)
  const text = selected ? selected.text : data.text
  const partOptions = [
    { value: 'all', label: `${t('all')} · ${parts.length} ${t('parts')}` },
    ...parts.map((item) => ({ value: item.shard, label: item.label || item.shard })),
  ]

  return (
    <div className="dshh-index-view">
      <div className="dshh-toolbar">
        <FilterSelect label={t('filterShard')} value={shard} options={shardOptions(t, shards)} onChange={onShardChange} />
        {parts.length > 1 ? (
          <FilterSelect label={t('parts')} value={part} options={partOptions} onChange={setPart} />
        ) : null}
        <span className="dshh-toolbar-meta dshh-muted">
          {`${formatBytes(data.bytes)} · ${t('generatedAtLabel')} ${absoluteTime(data.generatedAt)}`}
        </span>
        <CopyButton text={text} label={t('copy')} copiedLabel={t('copied')} />
      </div>
      <p className="dshh-muted dshh-small">{t('indexHint')}</p>
      {text.trim() ? (
        <pre className="dshh-pre dshh-pre-wrap">{text}</pre>
      ) : (
        <EmptyState title={t('emptyIndex')} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------ context preview */

export interface ContextViewProps extends ViewProps {
  onOpenMemory: (id: string) => void
}

/** Replay of the hot-index block injected at session start. */
export function ContextView({ face, t, refreshToken, onOpenMemory }: ContextViewProps): ReactNode {
  const result = useApi<InspectContext>(face, 'context.preview', undefined, refreshToken)
  const loading = gate(t, result, 'retry')
  if (loading) return loading
  const context = result.data
  if (!context) return <EmptyState title={t('emptyContext')} />

  const ids = context.ids ?? []
  const text = context.text ?? ''
  return (
    <div className="dshh-context-view">
      <div className="dshh-toolbar">
        <span className="dshh-toolbar-meta dshh-muted">{t('contextHint')}</span>
        <CopyButton text={text} label={t('copy')} copiedLabel={t('copied')} />
      </div>
      <Meter
        label={t('budgetUsed')}
        value={context.tokensEstimate}
        max={context.budgetTokens}
        text={`${formatCount(context.tokensEstimate)} / ${formatCount(context.budgetTokens)}`}
        over={context.atBudget}
      />
      <StatGrid>
        <Stat label={t('tokensEstimate')} value={formatCount(context.tokensEstimate)} />
        <Stat label={t('hotEntries')} value={formatCount(context.hotEntries)} />
        <Stat label={t('contextIds')} value={formatCount(ids.length)} />
        <Stat
          label={t('status')}
          value={context.atBudget ? t('atBudget') : t('withinBudget')}
          tone={context.atBudget ? 'warn' : 'success'}
        />
      </StatGrid>
      <Section title={t('budget')}>
        <KeyValue
          rows={[
            { label: t('cwd'), value: context.cwd ?? t('none'), mono: true },
            { label: t('project'), value: context.projectName ?? context.projectId ?? t('noProject') },
            { label: t('shards'), value: <Chips items={context.shards ?? []} emptyLabel={t('none')} /> },
            { label: t('bytes'), value: formatBytes(context.bytes) },
          ]}
        />
      </Section>
      <Section title={t('contextIds')}>
        <Chips items={ids} emptyLabel={t('none')} onSelect={onOpenMemory} />
      </Section>
      <Section title={t('tabContext')}>
        {text.trim() ? <pre className="dshh-pre dshh-pre-wrap">{text}</pre> : <EmptyState title={t('emptyContext')} />}
      </Section>
    </div>
  )
}

/* Re-export a couple of primitives for panel-level composition. */
export { Tabs }
