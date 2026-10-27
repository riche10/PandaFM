import { useStore } from 'zustand'
import type { CoverSize } from '../api/library'
import {artworkSrc, onReconnect, resolveSource } from '../offline'
import { platform } from '../platform/state'
import { createPlaybackEngine, usesBrowserMediaSession } from './engineSelect'
import { createNativeQueueStore, resyncNativePlayer } from './nativeStore'
import { MixPlanner } from './mixPlan'
/** Panda Mix plans (5.2): shared by the browser mixer and the transition bridges (and the Android bridges). */
export const mixPlanner = new MixPlanner((body) => apiSend('POST', '/mix/prepare', body))
import { apiSend } from '../api/client'
import { autoplaySettings } from './autoplay'
import { authFetch } from '../api/auth'
import { apiUrl } from '../api/client'
import { radioApi } from '../api/radio'
import { createReporter, type ListeningEvent, snapshot } from './events'
import { createAutoplay } from './autoplay'
import { createRadioController } from './radio'
import { toast } from '../library/toasts'
import { isOnline } from '../offline'
import { uuid } from './uuid'
import { explainPlaybackError } from './explain'
import { connectMediaSession } from './mediaSession'
import * as Q from './queue'
import { apiGet } from '../api/client'
import { parseSnapshot, SESSION_KEY, snapshotOf } from './session'
import { createPlayerStore, currentTrack, hasNext, type PlaybackReport, type PlayerStoreState } from './store'

// The app's one player: one engine, one store, created once.
export const audioEngine = createPlaybackEngine()
/** Android (5.0.1): the native playback service owns the queue; this app mirrors it. */
const nativeQueue = platform.kind === 'android' ? platform.player : null

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
    const response = await authFetch(apiUrl('/events'), {
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

export const playerStore = nativeQueue
  ? createNativeQueueStore(nativeQueue, savedVolume())
  : createPlayerStore({
      mixPlanner, // Panda Mix plans (5.2)
  engine: audioEngine,
  streamUrl: resolveSource, // a downloaded file when there is one, else the server stream
  explainError: explainPlaybackError,
  initialVolume: savedVolume(),
  report: (event) => reporter.report(toEvent(event)),
  newId: uuid,
  onQueueEnd: () => void autoplay.onQueueEnd(),
})

// 5.0: the playback session survives a restart on this device (restored paused; never plays by itself).
// Browsers only: on Android the playback service keeps the queue (a 5.0 snapshot is migrated once).
if (nativeQueue) {
  const MIGRATED = 'pandafm.session.native-migrated'
  try {
    const saved = localStorage.getItem(MIGRATED) ? null : parseSnapshot(localStorage.getItem(SESSION_KEY))
    if (saved) void nativeQueue.migrate({ snapshot: JSON.stringify(saved) }).catch(() => undefined)
    localStorage.setItem(MIGRATED, '1')
  } catch {
    // storage unavailable: nothing to migrate
  }
} else {
  const saved = typeof localStorage === 'undefined' ? null : parseSnapshot(localStorage.getItem(SESSION_KEY))
  if (saved) {
    playerStore.getState().restore(saved)
    const radio = saved.source?.radio
    if (radio?.sessionId) {
      // Keep the songs; drop the radio link if that session has ended on the server.
      apiGet(`/radio/sessions/${encodeURIComponent(radio.sessionId)}`).catch(() => {
        const s = playerStore.getState()
        if (s.source?.radio?.sessionId === radio.sessionId) playerStore.setState({ source: { ...s.source, radio: undefined } })
      })
    }
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastPositionSave = 0
  playerStore.subscribe((state, prev) => {
    if (typeof localStorage === 'undefined') return
    const onlyPosition = state.items === prev.items && state.index === prev.index && state.source === prev.source && state.shuffle === prev.shuffle && state.repeat === prev.repeat
    if (onlyPosition && Date.now() - lastPositionSave < 5000) return
    if (timer) return // a write is already on its way (a throttle: playback's constant position updates mustn't postpone it forever)
    timer = setTimeout(() => {
      timer = null
      lastPositionSave = Date.now()
      const snap = snapshotOf(playerStore.getState())
      try {
        if (snap) localStorage.setItem(SESSION_KEY, JSON.stringify(snap))
        else localStorage.removeItem(SESSION_KEY)
      } catch {
        // storage full: the session just won't survive a restart
      }
    }, 800)
  })
}

// Listening while offline is buffered; send it the moment the server is reachable again.
onReconnect(() => void reporter.flush())

if (typeof document !== 'undefined') {
  // Send what's buffered when the app goes to the background (phones may kill it there).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void reporter.flush()
  })
}

/** Panda Radio, feeding the shared queue above. */
export const radio = createRadioController({ api: radioApi, store: playerStore, reporter, onEnd: () => autoplay.suppress(), nativeRefill: !!nativeQueue })

/** Autoplay: a finished song, album or playlist carries on as Panda Radio (Settings › Playback). */
export const autoplay = createAutoplay({ store: playerStore, radio, online: isOnline, notify: toast })

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
// On Android the native Media3 session does this instead (never both).
if (usesBrowserMediaSession(platform) && typeof navigator !== 'undefined' && 'mediaSession' in navigator && typeof MediaMetadata !== 'undefined') {
  connectMediaSession(
    playerStore,
    navigator.mediaSession,
    (init) => new MediaMetadata(init),
    (id, size) => new URL(artworkSrc(id, size as CoverSize), window.location.href).href,
  )
}

// Android: lock screen, notification, Bluetooth, headsets and Android Auto act on the
// native queue directly (no JavaScript involved); this app sees the result in snapshots.
if (nativeQueue) {
  const sync = () => {
    const a = autoplaySettings.getState()
    void nativeQueue.setPreferences({ autoplayEnabled: a.enabled, autoplayPreset: a.preset }).catch(() => undefined)
  }
  sync()
  autoplaySettings.subscribe(sync)
}

/** Android: re-read the native queue now (e.g. when Now Playing opens). No-op in browsers. */
export const resyncPlayer = () => (nativeQueue ? resyncNativePlayer() : Promise.resolve())

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
