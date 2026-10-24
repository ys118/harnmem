import { useCallback, useState, type ReactNode } from 'react'

/** Shared presentational building blocks. All are SSR-safe (no effects). */

export type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'

/** Small rounded label. */
export function Badge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: Tone
  title?: string
}): ReactNode {
  return (
    <span className={`dshh-badge dshh-badge-${tone}`} title={title}>
      {children}
    </span>
  )
}

/** Section wrapper with an optional right-aligned extra slot. */
export function Section({
  title,
  extra,
  children,
  className,
}: {
  title: ReactNode
  extra?: ReactNode
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <section className={className ? `dshh-section ${className}` : 'dshh-section'}>
      <div className="dshh-section-head">
        <h3 className="dshh-section-title">{title}</h3>
        {extra ? <div className="dshh-section-extra">{extra}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** Responsive grid of stats. */
export function StatGrid({ children }: { children: ReactNode }): ReactNode {
  return <div className="dshh-stat-grid">{children}</div>
}

/** One number tile. */
export function Stat({
  label,
  value,
  hint,
  tone,
  onClick,
}: {
  label: string
  value: ReactNode
  hint?: string
  tone?: Tone
  onClick?: () => void
}): ReactNode {
  const className = `dshh-stat${tone ? ` dshh-stat-${tone}` : ''}`
  const content = (
    <>
      <div className="dshh-stat-label">{label}</div>
      <div className="dshh-stat-value">{value}</div>
      {hint ? <div className="dshh-stat-hint">{hint}</div> : null}
    </>
  )
  if (onClick) {
    return (
      <button type="button" className={`${className} dshh-stat-clickable`} onClick={onClick}>
        {content}
      </button>
    )
  }
  return <div className={className}>{content}</div>
}

/** Horizontal budget meter, `value` out of `max`. */
export function Meter({
  label,
  value,
  max,
  text,
  over,
}: {
  label: string
  value: number
  max: number
  text?: string
  over?: boolean
}): ReactNode {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="dshh-meter">
      <div className="dshh-meter-head">
        <span>{label}</span>
        <span className="dshh-muted">{text ?? `${percent}%`}</span>
      </div>
      <div className="dshh-meter-track">
        <div
          className={over ? 'dshh-meter-bar dshh-meter-bar-over' : 'dshh-meter-bar'}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

/** Loading skeleton; must render without any request having resolved. */
export function LoadingState({ label }: { label: string }): ReactNode {
  return (
    <div className="dshh-state dshh-loading-state" aria-busy="true" aria-live="polite">
      <div className="dshh-skeleton dshh-skeleton-title" />
      <div className="dshh-skeleton" />
      <div className="dshh-skeleton dshh-skeleton-short" />
      <p className="dshh-muted">{label}</p>
    </div>
  )
}

/** Load failure with a retry action. */
export function ErrorState({
  title,
  message,
  retryLabel,
  onRetry,
}: {
  title: string
  message: string
  retryLabel: string
  onRetry?: () => void
}): ReactNode {
  return (
    <div className="dshh-state dshh-error-state" role="alert">
      <div className="dshh-state-title">{title}</div>
      <p className="dshh-error">{message}</p>
      {onRetry ? (
        <button type="button" className="dshh-btn" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  )
}

/** No-data pane. */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className="dshh-state dshh-empty-state">
      <div className="dshh-state-title">{title}</div>
      {hint ? <p className="dshh-muted">{hint}</p> : null}
      {action}
    </div>
  )
}

/** Tab bar. */
export function Tabs<Id extends string>({
  items,
  active,
  onChange,
}: {
  items: ReadonlyArray<{ id: Id; label: string; badge?: string }>
  active: Id
  onChange: (id: Id) => void
}): ReactNode {
  return (
    <div className="dshh-tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === active}
          className={item.id === active ? 'dshh-tab dshh-tab-active' : 'dshh-tab'}
          onClick={() => onChange(item.id)}
        >
          {item.label}
          {item.badge ? <span className="dshh-tab-badge">{item.badge}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** Filter segmented control (single select). */
export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
}): ReactNode {
  return (
    <label className="dshh-filter">
      <span className="dshh-filter-label">{label}</span>
      <select className="dshh-select" value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Two-column key/value list used by the detail and overview panes. */
export function KeyValue({
  rows,
}: {
  rows: ReadonlyArray<{ label: string; value: ReactNode; mono?: boolean }>
}): ReactNode {
  return (
    <dl className="dshh-kv">
      {rows.map((row) => (
        <div className="dshh-kv-row" key={row.label}>
          <dt className="dshh-kv-key">{row.label}</dt>
          <dd className={row.mono ? 'dshh-kv-value dshh-mono' : 'dshh-kv-value'}>{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Wrap chips, optionally clickable (memory ids, tags). */
export function Chips({
  items,
  emptyLabel,
  onSelect,
}: {
  items: readonly string[]
  emptyLabel?: string
  onSelect?: (item: string) => void
}): ReactNode {
  if (items.length === 0) return <span className="dshh-muted">{emptyLabel ?? '—'}</span>
  return (
    <span className="dshh-chips">
      {items.map((item) => {
        const label = <span className="dshh-chip-label">{item}</span>
        return onSelect ? (
          <button key={item} type="button" className="dshh-chip dshh-chip-button" onClick={() => onSelect(item)}>
            {label}
          </button>
        ) : (
          <span key={item} className="dshh-chip">
            {label}
          </span>
        )
      })}
    </span>
  )
}

/** Copy-to-clipboard button; degrades to a no-op without the Clipboard API. */
export function CopyButton({ text, label, copiedLabel }: { text: string; label: string; copiedLabel: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback((): void => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return
    void clipboard.writeText(text).then(
      () => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      },
      () => undefined,
    )
  }, [text])
  return (
    <button type="button" className="dshh-btn dshh-btn-small" onClick={onCopy}>
      {copied ? copiedLabel : label}
    </button>
  )
}
