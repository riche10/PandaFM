import { authFetch } from '../api/auth'
import { useEffect, useState } from 'react'
import { type CoverSize, coverUrl } from '../api/library'
import { directArtworkSrc, isOnline } from '../offline'
import { createArtworkCache } from '../platform/artwork'

const cache = createArtworkCache({
  fetcher: (url) => authFetch(url), // Android: artwork needs the Bearer token too
  createUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
})

/**
 * The src for a cover: direct on the web and for artwork saved on the device;
 * fetched through the API (blob: URL) for remote covers in the Android app.
 * null while it loads, when offline without a saved copy, or when there's none.
 */
export function useCoverSrc(coverArtId: string | null, size: CoverSize): string | null {
  const direct = coverArtId ? directArtworkSrc(coverArtId, size) : null
  const remote = coverArtId && !direct ? coverUrl(coverArtId, size) : null
  const [fetched, setFetched] = useState<string | null>(() => (remote ? cache.peek(remote) : null))

  useEffect(() => {
    if (!remote) return
    if (!isOnline() && !cache.peek(remote)) return setFetched(null)
    let live = true
    setFetched(cache.peek(remote))
    void cache.acquire(remote).then((url) => {
      if (live) setFetched(url)
    })
    return () => {
      live = false
      cache.release(remote)
    }
  }, [remote])

  return direct ?? fetched
}
