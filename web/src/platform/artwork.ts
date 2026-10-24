// Remote artwork for the Android app.
//
// From the app's https://localhost page, Chromium refuses <img> loads from a
// plain-http server on an IP address (mixed content that can't be upgraded),
// while fetch() is allowed. So the app fetches covers through the PandaFM API
// and shows them as same-origin blob: URLs. Each cover is fetched once, shared
// by every component showing it, and revoked when no longer used (bounded).

export interface ArtworkCacheDeps {
  fetcher: (url: string) => Promise<Response>
  createUrl: (blob: Blob) => string
  revokeUrl: (url: string) => void
  max?: number
  now?: () => number
}

interface Entry {
  objectUrl: string | null
  promise: Promise<string | null> | null
  refs: number
  used: number
  failedAt: number | null
}

const RETRY_FAILED_MS = 60_000

export function createArtworkCache({ fetcher, createUrl, revokeUrl, max = 120, now = Date.now }: ArtworkCacheDeps) {
  const entries = new Map<string, Entry>()

  const evict = () => {
    if (entries.size <= max) return
    const idle = [...entries.entries()].filter(([, e]) => e.refs <= 0 && !e.promise).sort((a, b) => a[1].used - b[1].used)
    for (const [url, e] of idle) {
      if (entries.size <= max) break
      if (e.objectUrl) revokeUrl(e.objectUrl)
      entries.delete(url)
    }
  }

  return {
    /** Start using a cover; resolves to a blob: URL, or null if it couldn't be fetched. */
    acquire(url: string): Promise<string | null> {
      let e = entries.get(url)
      if (!e) {
        e = { objectUrl: null, promise: null, refs: 0, used: 0, failedAt: null }
        entries.set(url, e)
      }
      e.refs++
      e.used = now()
      if (e.objectUrl) return Promise.resolve(e.objectUrl)
      if (e.promise) return e.promise
      if (e.failedAt !== null && now() - e.failedAt < RETRY_FAILED_MS) return Promise.resolve(null)
      const entry = e
      entry.promise = fetcher(url)
        .then(async (response) => {
          const blob = response.ok ? await response.blob() : null
          if (!blob || !blob.type.startsWith('image/')) throw new Error('not an image')
          entry.objectUrl = createUrl(blob)
          return entry.objectUrl
        })
        .catch(() => {
          entry.failedAt = now()
          return null
        })
        .finally(() => {
          entry.promise = null
          evict()
        })
      return entry.promise
    },
    /** Stop using a cover (it may be revoked later if space is needed). */
    release(url: string): void {
      const e = entries.get(url)
      if (e) e.refs = Math.max(0, e.refs - 1)
      evict()
    },
    /** Already fetched? Lets a re-render show it at once. */
    peek(url: string): string | null {
      return entries.get(url)?.objectUrl ?? null
    },
    size: () => entries.size,
  }
}
