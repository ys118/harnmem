import type { PanelIconProps } from './contract'

/**
 * Sidebar entry icon: a symmetrical memory card.
 * Rendered by the sidebar's global panel row (16px expanded, 18px on the rail).
 */
export function MemoryPanelIcon({ size }: PanelIconProps) {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="3.5" width="16" height="17" rx="3" />
      <path d="M8 8.5h5" />
      <path d="M8 12h8" />
      <path d="M8 15.5h6" />
      <path d="M15.5 7.2v2.6" />
    </svg>
  )
}
