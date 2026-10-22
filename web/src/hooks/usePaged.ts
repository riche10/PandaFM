import { useCallback, useEffect, useRef, useState } from 'react'
import { type ApiError, toApiError } from '../api/client'

export interface Paged<T> {
  items: T[]
  state: 'loading' | 'ready' | 'error'
  error: ApiError | null
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
  retry: () => void
}

/**
 * A list loaded a page at a time ("Load more"). Starts over when `key`
 * changes (e.g. a different sort). Items are de-duplicated by id, which
 * matters for random lists.
 */
export function usePaged<T extends { id: string }>(
  key: string,
  loadPage: (offset: number, size: number, signal: AbortSignal) => Promise<T[]>,
  pageSize: number,
): Paged<T> {
  const [items, setItems] = useState<T[]>([])
  const [state, setState] = useState<Paged<T>['state']>('loading')
  const [error, setError] = useState<ApiError | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const loadRef = useRef(loadPage)
  const controller = useRef<AbortController | null>(null)
  const count = useRef(0)

  useEffect(() => {
    loadRef.current = loadPage
    count.current = items.length
  })

  const fetchPage = useCallback(
    async (offset: number, replace: boolean) => {
      controller.current?.abort()
      const current = new AbortController()
      controller.current = current
      try {
        const page = await loadRef.current(offset, pageSize, current.signal)
        if (current.signal.aborted) return
        setItems((previous) => {
          const base = replace ? [] : previous
          const seen = new Set(base.map((item) => item.id))
          return [...base, ...page.filter((item) => !seen.has(item.id))]
        })
        setHasMore(page.length === pageSize)
        setState('ready')
        setError(null)
      } catch (err) {
        if (current.signal.aborted) return
        setError(toApiError(err))
        if (replace) setState('error')
      } finally {
        if (!current.signal.aborted) setLoadingMore(false)
      }
    },
    [pageSize],
  )

  useEffect(() => {
    setItems([])
    setState('loading')
    setHasMore(true)
    void fetchPage(0, true)
    return () => controller.current?.abort()
  }, [key, attempt, fetchPage])

  const loadMore = useCallback(() => {
    setLoadingMore(true)
    void fetchPage(count.current, false)
  }, [fetchPage])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { items, state, error, hasMore, loadingMore, loadMore, retry }
}
