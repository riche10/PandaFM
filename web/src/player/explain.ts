import { authFetch } from '../api/auth'
import { readApiError } from '../api/client'
import { streamUrl } from '../api/library'
import { PLAYBACK_ERROR_MESSAGES } from './store'
import type { PlaybackErrorKind } from './types'

/**
 * An <audio> element only says "it failed". Ask the API for the first two
 * bytes of the same stream to learn why: a missing song or Navidrome being
 * down comes back as a readable PandaFM error; if the stream is fine, the
 * browser itself couldn't play the file.
 */
export async function explainPlaybackError(trackId: string, kind: PlaybackErrorKind, fallback = PLAYBACK_ERROR_MESSAGES[kind]): Promise<string> {
  try {
    const response = await authFetch(streamUrl(trackId), { headers: { Range: 'bytes=0-1' } })
    if (!response.ok) return (await readApiError(response)).message
    await response.body?.cancel()
  } catch {
    return 'PandaFM’s server couldn’t be reached.'
  }
  return fallback // the stream is fine: keep the engine's own explanation
}
