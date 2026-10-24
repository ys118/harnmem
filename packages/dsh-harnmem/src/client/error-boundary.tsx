import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Props for {@link PanelErrorBoundary}. */
export interface PanelErrorBoundaryProps {
  /** Heading shown in the fallback pane. */
  title?: string
  /** Retry button label; the button clears the captured error and re-renders. */
  retryLabel?: string
  children?: ReactNode
  /** Custom fallback renderer for the captured error. */
  fallback?: (error: unknown) => ReactNode
  /**
   * Seeds the boundary in its errored state.
   *
   * React 19's synchronous server renderer (`renderToString`) rethrows render
   * errors instead of consulting class error boundaries, so SSR tests inject
   * the error here to exercise the fallback deterministically. Runtime code
   * never passes this prop: in the browser the boundary captures thrown errors
   * through `getDerivedStateFromError`.
   */
  initialError?: unknown
}

interface PanelErrorBoundaryState {
  error: unknown
}

/** Message extraction for arbitrary thrown values. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  if (error === undefined || error === null) return 'unknown error'
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Default fallback UI. Kept as a standalone component so tests (and hosts that
 * want a custom chrome) can render it without instantiating the boundary.
 */
export function PanelErrorFallback({
  title,
  message,
  retryLabel,
  onRetry,
}: {
  title?: string
  message: string
  retryLabel?: string
  onRetry?: () => void
}): ReactNode {
  return (
    <div className="dshh-state dshh-error-state" role="alert">
      <div className="dshh-state-title">{title ?? '面板渲染失败'}</div>
      <p className="dshh-error">{message}</p>
      {onRetry ? (
        <button type="button" className="dshh-btn" onClick={onRetry}>
          {retryLabel ?? '重试'}
        </button>
      ) : null}
    </div>
  )
}

/**
 * Error boundary around the panel body: a broken view must never take the
 * whole main slot (and with it the GUI) down.
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  override state: PanelErrorBoundaryState

  constructor(props: PanelErrorBoundaryProps) {
    super(props)
    this.state = { error: props.initialError ?? null }
  }

  static getDerivedStateFromError(error: unknown): PanelErrorBoundaryState {
    return { error }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (typeof console !== 'undefined') {
      console.error('[dsh-harnmem] panel render error', error, info.componentStack)
    }
  }

  private readonly retry = (): void => {
    this.setState({ error: null })
  }

  override render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    if (this.props.fallback) return this.props.fallback(error)
    return (
      <PanelErrorFallback
        title={this.props.title}
        message={errorMessage(error)}
        retryLabel={this.props.retryLabel}
        onRetry={this.retry}
      />
    )
  }
}
