/** Small, dependency-free formatters shared by the panel views. */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** Human-readable byte size, e.g. `12.4 KB`. */
export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '—'
  const value = Math.max(0, bytes)
  if (value < 1024) return `${Math.round(value)} B`
  let unit = 0
  let scaled = value
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024
    unit += 1
  }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2
  return `${scaled.toFixed(digits)} ${BYTE_UNITS[unit] ?? 'B'}`
}

/** Compact integer formatting, e.g. `1.2k`. */
export function formatCount(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  const rounded = Math.round(value)
  if (Math.abs(rounded) < 10_000) return String(rounded)
  if (Math.abs(rounded) < 1_000_000) return `${(rounded / 1000).toFixed(1)}k`
  return `${(rounded / 1_000_000).toFixed(1)}M`
}

/** Localized relative time; falls back to an ISO date for old/absent stamps. */
export function relativeTime(
  timestamp: number | undefined | null,
  now: number,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const delta = Math.max(0, now - timestamp)
  const minute = 60_000
  if (delta < minute) return t('timeJustNow')
  if (delta < 60 * minute) return t('timeMinutes', { count: Math.floor(delta / minute) })
  if (delta < 24 * 60 * minute) return t('timeHours', { count: Math.floor(delta / (60 * minute)) })
  if (delta < 30 * 24 * 60 * minute) return t('timeDays', { count: Math.floor(delta / (24 * 60 * minute)) })
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Absolute `YYYY-MM-DD HH:mm` timestamp for tooltips and detail rows. */
export function absoluteTime(timestamp: number | undefined | null): string {
  if (!timestamp || !Number.isFinite(timestamp)) return '—'
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Truncate by characters, adding an ellipsis when shortened. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

/** Percentage of a budget, clamped to 0..100 for progress meters. */
export function ratio(used: number | undefined, total: number | undefined): number {
  if (!used || !total || total <= 0) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}
