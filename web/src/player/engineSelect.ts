import type { Track } from '../api/library'
import type { PlatformState } from '../platform/state'
import { AudioEngine } from './engine.ts'
import { NativePlaybackEngine } from './nativeEngine.ts'
import type { PlaybackEngine } from './types'

/** The platform boundary: browsers play through <audio>; the Android app through Media3. */
export function createPlaybackEngine(p: Pick<PlatformState, 'kind' | 'player'>, deps: { artworkFor: (track: Track) => string | null }): PlaybackEngine {
  if (p.kind === 'android' && p.player) return new NativePlaybackEngine(p.player, deps)
  return new AudioEngine()
}

/** One media session per platform: the browser's on the web, Media3's native one on Android. */
export const usesBrowserMediaSession = (p: Pick<PlatformState, 'kind' | 'player'>) => !(p.kind === 'android' && p.player)
