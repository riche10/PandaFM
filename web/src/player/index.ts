import { useStore } from 'zustand'
import { coverUrl, type CoverSize, streamUrl } from '../api/library'
import { AudioEngine } from './engine'
import { explainPlaybackError } from './explain'
import { connectMediaSession } from './mediaSession'
import * as Q from './queue'
import { createPlayerStore, currentTrack, hasNext, type PlayerStoreState } from './store'

// The app's one player: one engine, one store, created once.
export const audioEngine = new AudioEngine()

const VOLUME_KEY = 'pandafm.volume'

function savedVolume(): number {
  try {
    const value = Number(localStorage.getItem(VOLUME_KEY))
    return localStorage.getItem(VOLUME_KEY) !== null && value >= 0 && value <= 1 ? value : 1
  } catch {
    return 1
  }
}

export const playerStore = createPlayerStore({
  engine: audioEngine,
  streamUrl,
  explainError: explainPlaybackError,
  initialVolume: savedVolume(),
})

// Remember the volume between visits (this browser only).
playerStore.subscribe((state, previous) => {
  if (state.volume === previous.volume) return
  try {
    localStorage.setItem(VOLUME_KEY, String(state.volume))
  } catch {
    // Private mode or storage disabled: the volume just isn't remembered.
  }
})

/** Read player state in a component. Pick small slices so only they re-render. */
export function usePlayer<T>(selector: (state: PlayerStoreState) => T): T {
  return useStore(playerStore, selector)
}

export const useCurrentTrack = () => usePlayer(currentTrack)
export const useHasNext = () => usePlayer(hasNext)

// Lock screen, notification and media keys, where the browser supports them.
if (typeof navigator !== 'undefined' && 'mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
  connectMediaSession(
    playerStore,
    navigator.mediaSession,
    (init) => new MediaMetadata(init),
    (id, size) => new URL(coverUrl(id, size as CoverSize), window.location.href).href,
  )
}

/** Player actions for event handlers. Stable functions, safe to call anywhere. */
export const player = {
  playCollection: (...args: Parameters<PlayerStoreState['playCollection']>) => playerStore.getState().playCollection(...args),
  playNext: (...args: Parameters<PlayerStoreState['playNext']>) => playerStore.getState().playNext(...args),
  addToQueue: (...args: Parameters<PlayerStoreState['addToQueue']>) => playerStore.getState().addToQueue(...args),
  removeFromQueue: (uid: string) => playerStore.getState().removeFromQueue(uid),
  clearQueue: (which?: 'all' | 'manual') => playerStore.getState().clearQueue(which),
  jumpTo: (uid: string) => playerStore.getState().jumpTo(uid),
  moveInQueue: (uid: string, direction: -1 | 1) => playerStore.getState().moveInQueue(uid, direction),
  toggleShuffle: () => playerStore.getState().toggleShuffle(),
  cycleRepeat: () => playerStore.getState().cycleRepeat(),
  togglePlay: () => playerStore.getState().togglePlay(),
  play: () => playerStore.getState().play(),
  pause: () => playerStore.getState().pause(),
  seek: (seconds: number) => playerStore.getState().seek(seconds),
  next: () => playerStore.getState().next(),
  previous: () => playerStore.getState().previous(),
  setVolume: (volume: number) => playerStore.getState().setVolume(volume),
  toggleMute: () => playerStore.getState().toggleMute(),
}

export { countOf, formatLength, formatTime } from './format'

export { Q as queue }
export type { QueueItem, QueueSource, RepeatMode } from './queue'
