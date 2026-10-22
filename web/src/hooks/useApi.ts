import { useCallback, useEffect, useRef, useState } from 'react'
import { type ApiError, toApiError } from '../api/client'

export type Resource<T> =
  | { state: 'loading'; previous?: T }
  | { state: 'ready'; data: T }
  | { state: 'error'; error: ApiError }

/**
 * Load data for a view. Reloads when `key` changes, aborts requests that are
 * no longer wanted, and keeps the last result available as `previous` while
 * reloading, so refining a search doesn't flash an empty screen.
 */
export function useApi<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
): [Resource<T>, () => void] {
  const [resource, setResource] = useState<Resource<T>>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(load)

  useEffect(() => {
    loadRef.current = load
  })

  useEffect(() => {
    const controller = new AbortController()
    setResource((prev) => ({
      state: 'loading',
      previous: prev.state === 'ready' ? prev.data : prev.state === 'loading' ? prev.previous : undefined,
    }))
    loadRef.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setResource({ state: 'ready', data })
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setResource({ state: 'error', error: toApiError(err) })
      },
    )
    return () => controller.abort()
  }, [key, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return [resource, retry]
}
