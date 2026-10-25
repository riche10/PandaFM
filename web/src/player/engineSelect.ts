import { AudioEngine } from './engine.ts'
import type { PlatformState } from '../platform/state'
import type { PlaybackEngine } from './types'

/**
 * Browsers play through <audio> with the web queue. The Android app doesn't use
 * an engine here: the native playback service owns its queue (player/nativeStore.ts).
 */
export function createPlaybackEngine(): PlaybackEngine {
  return new AudioEngine()
}

/** One media session per platform: the browser's on the web, Media3's native one on Android. */
export const usesBrowserMediaSession = (p: Pick<PlatformState, 'kind' | 'player'>) => !(p.kind === 'android' && p.player)
