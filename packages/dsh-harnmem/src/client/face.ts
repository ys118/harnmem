/** Thin client for the host-side `/api/harnmem/*` read-only endpoints. */

interface ApiEnvelope<T> {
  ok: boolean
  data?: T
  error?: string
}

/** Raised for transport or `{ok:false}` responses; message is user-presentable. */
export class MemoryApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'MemoryApiError'
  }
}

export type QueryValue = string | number | boolean | undefined

export interface MemoryFace {
  request<T>(route: string, query?: Record<string, QueryValue>): Promise<T>
  cwd(): string | undefined
}

/**
 * Builds the fetch bridge bound to the plugin's context.
 * @param getCwd resolves the working directory of the session shown in the panel;
 *   the host falls back to its most recent session when omitted.
 */
export function createFace(getCwd: () => string | undefined): MemoryFace {
  async function request<T>(route: string, query: Record<string, QueryValue> = {}): Promise<T> {
    const base = typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost'
    const url = new URL(`/api/harnmem/${route}`, base)
    const cwd = getCwd()
    if (cwd) url.searchParams.set('cwd', cwd)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value))
    }
    let response: Response
    try {
      response = await fetch(url.toString(), { headers: { accept: 'application/json' } })
    } catch (error) {
      throw new MemoryApiError(error instanceof Error ? error.message : String(error))
    }
    let body: ApiEnvelope<T> | undefined
    try {
      body = (await response.json()) as ApiEnvelope<T>
    } catch {
      throw new MemoryApiError(`Unexpected response (HTTP ${response.status})`, response.status)
    }
    if (!response.ok || !body?.ok) {
      throw new MemoryApiError(body?.error ?? `Request failed (HTTP ${response.status})`, response.status)
    }
    return body.data as T
  }

  return { request, cwd: getCwd }
}
