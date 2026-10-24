import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryFace, QueryValue } from './face'
import { errorMessage } from './error-boundary'

/** Lifecycle of one `face.request()` load. */
export type ApiStatus = 'loading' | 'ready' | 'error'

/** Snapshot returned by {@link useApi}. */
export interface ApiState<T> {
  status: ApiStatus
  data: T | undefined
  error: string | undefined
}

/** {@link ApiState} plus a manual reload trigger. */
export interface ApiResult<T> extends ApiState<T> {
  reload: () => void
}

/**
 * Loads one panel API route and keeps the last request winning.
 *
 * Race protection: every `reload()` (and every query/face/reloadToken change,
 * including unmount) bumps a generation counter; a response from an older
 * generation is dropped instead of overwriting the fresher state. The initial
 * state is `loading` and no request is issued during render, which keeps the
 * first render (and server-side rendering) side-effect free.
 *
 * @param reloadToken opaque value; changing it refetches (used by the panel's
 *   global refresh button without remounting the view and losing local state).
 */
export function useApi<T>(
  face: MemoryFace | undefined,
  route: string,
  query?: Record<string, QueryValue>,
  reloadToken?: unknown,
): ApiResult<T> {
  const [state, setState] = useState<ApiState<T>>({ status: 'loading', data: undefined, error: undefined })
  const generation = useRef(0)
  const queryKey = query ? JSON.stringify(query) : ''

  const reload = useCallback((): void => {
    generation.current += 1
    const current = generation.current
    if (!face) {
      setState({ status: 'error', data: undefined, error: 'memory API bridge is not wired' })
      return
    }
    setState({ status: 'loading', data: undefined, error: undefined })
    let params: Record<string, QueryValue> | undefined
    if (queryKey) {
      try {
        params = JSON.parse(queryKey) as Record<string, QueryValue>
      } catch {
        params = undefined
      }
    }
    face.request<T>(route, params).then(
      (data) => {
        if (generation.current !== current) return
        setState({ status: 'ready', data, error: undefined })
      },
      (error: unknown) => {
        if (generation.current !== current) return
        setState({ status: 'error', data: undefined, error: errorMessage(error) })
      },
    )
  }, [face, route, queryKey, reloadToken])

  useEffect(() => {
    reload()
    return () => {
      // Invalidate the in-flight request so it cannot land after unmount.
      generation.current += 1
    }
  }, [reload])

  return { ...state, reload }
}

/** Ticking clock used only for relative timestamps; cleans its timer up. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
