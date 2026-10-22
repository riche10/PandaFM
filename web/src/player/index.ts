import { useStore } from 'zustand'
import { coverUrl, type CoverSize, streamUrl } from '../api/library'
import { radioApi } from '../api/radio'
import { createReporter, type ListeningEvent, snapshot } from './events'
import { createRadioController } from './radio'
import { uuid } from './uuid'
import { AudioEngine } from './engine'
import { explainPlaybackError } from './explain'
import { connectMediaSession } from './mediaSession'
import * as Q from './queue'
import { createPlayerStore, currentTrack, hasNext, type PlaybackReport, type PlayerStoreState } from './store'

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

const EVENTS_KEY = 'pandafm.pending-events'

/** Listening events go to the API in batches; unsent ones survive a closed tab. */
export const reporter = createReporter({
  send: async (events) => {
    const response = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
      keepalive: true, // let a batch finish even if the page is closing
    })
    if (!response.ok) throw new Error(`events rejected: ${response.status}`)
  },
  storage: {
    load: () => localStorage.getItem(EVENTS_KEY),
    save: (value) => localStorage.setItem(EVENTS_KEY, value),
  },
})

function toEvent(report: PlaybackReport): ListeningEvent {
  const { item, source } = report
  return {
    event_id: uuid(),
    type: report.type,
    track: snapshot(item.track),
    play_id: report.playId,
    occurred_at: new Date().toISOString(),
    position_s: Math.round(report.position * 10) / 10,
    duration_s: report.duration || null,
    source: item.radio ? 'radio' : item.origin === 'manual' ? 'queue' : (source?.kind ?? 'library'),
    mode: item.radio ? (source?.radio?.mode ?? null) : null,
    radio_session_id: item.radio?.sessionId ?? null,
    radio_selection_id: item.radio?.selectionId ?? null,
    details: report.details ?? {},
  }
}

export const playerStore = createPlayerStore({
  engine: audioEngine,
  streamUrl,
  explainError: explainPlaybackError,
  initialVolume: savedVolume(),
  report: (event) => reporter.report(toEvent(event)),
  newId: uuid,
})

if (typeof document !== 'undefined') {
  // Send what's buffered when the app goes to the background (phones may kill it there).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void reporter.flush()
  })
}

/** Panda Radio, feeding the shared queue above. */
export const radio = createRadioController({ api: radioApi, store: playerStore, reporter })

/** The active radio session, or null. */
export const useRadio = () => usePlayer((s) => (s.source?.kind === 'radio' ? (s.source.radio ?? null) : null))

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
export type { QueueItem, QueueSource, RadioInfo, RepeatMode } from './queue'
