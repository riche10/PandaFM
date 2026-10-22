import { useStore } from 'zustand'
import { streamUrl } from '../api/library'
import { AudioEngine } from './engine'
import { explainPlaybackError } from './explain'
import { createPlayerStore, currentTrack, type PlayerStoreState } from './store'

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

/** Player actions for event handlers. Stable functions, safe to call anywhere. */
export const player = {
  playTracks: (...args: Parameters<PlayerStoreState['playTracks']>) => playerStore.getState().playTracks(...args),
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
