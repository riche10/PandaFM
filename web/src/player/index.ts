import { useStore } from 'zustand'
import { streamUrl } from '../api/library'
import { AudioEngine } from './engine'
import { explainPlaybackError } from './explain'
import { createPlayerStore, currentTrack, type PlayerStoreState } from './store'

// The app's one player: one engine, one store, created once.
export const audioEngine = new AudioEngine()

export const playerStore = createPlayerStore({
  engine: audioEngine,
  streamUrl,
  explainError: explainPlaybackError,
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
}

export { formatTime } from './format'
