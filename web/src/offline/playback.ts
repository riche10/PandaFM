import type { OfflineSettings } from './settings'
import type { OfflineTrack } from './types'
import { playable } from './types.ts'

/**
 * Where the player should get a song: the downloaded file when there is one
 * (and you prefer it), otherwise the server stream when it's reachable,
 * otherwise nothing (and the player says the song isn't available offline).
 */
export function createSourceResolver(deps: {
  track: (id: string) => OfflineTrack | undefined
  settings: () => OfflineSettings
  online: () => boolean
  localFileUrl: (uri: string) => string
  streamUrl: (id: string) => string
}): (trackId: string) => string | null {
  return (trackId) => {
    const entry = deps.track(trackId)
    const local = playable(entry) ? deps.localFileUrl(entry!.localUri!) : null
    const { preferLocal, streamFallback } = deps.settings()
    if (local && (preferLocal || !deps.online())) return local
    if (streamFallback && deps.online()) return deps.streamUrl(trackId)
    return local
  }
}
