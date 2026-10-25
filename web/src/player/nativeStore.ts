import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Track } from '../api/library'
import type { NativeState, PandaPlayerPlugin } from '../platform/native'
import type { PlayerStoreState } from './store'
import type { QueueItem, QueueSource, RadioPickInput, RepeatMode } from './queue'

/**
 * Android (5.0.1): the player store as a mirror of the native queue. Actions send
 * commands to the playback service and change nothing here; state changes only
 * when the service publishes a snapshot. One authority, no ping-pong.
 */
export interface NativeSnapshot {
  items: QueueItem[]
  index: number
  source: QueueSource | null
  shuffle: boolean
  repeat: RepeatMode
  status: string
  error: string | null
  positionMs: number
  durationMs: number
}

const STATUSES = new Set(['idle', 'loading', 'playing', 'paused', 'ended', 'error'])

export function fromSnapshot(raw: string): Partial<PlayerStoreState> | null {
  try {
    const s = JSON.parse(raw) as NativeSnapshot
    if (!Array.isArray(s.items)) return null
    return {
      items: s.items,
      index: Number.isInteger(s.index) ? s.index : -1,
      source: s.source ?? null,
      shuffle: !!s.shuffle,
      ordered: null,
      repeat: s.repeat === 'all' || s.repeat === 'one' ? s.repeat : 'off',
      ...fromState({ status: s.status, positionMs: s.positionMs, durationMs: s.durationMs, error: s.error, gen: 0 }),
    }
  } catch {
    return null
  }
}

export function fromState(e: NativeState): Partial<PlayerStoreState> {
  const status = (STATUSES.has(e.status) ? e.status : 'idle') as PlayerStoreState['status']
  return { status, position: Math.max(0, (e.positionMs ?? 0) / 1000), duration: Math.max(0, (e.durationMs ?? 0) / 1000), error: e.error ?? null }
}

const json = (v: unknown) => JSON.stringify(v ?? null)
const picksOut = (picks: RadioPickInput[]) => json(picks.map((p) => ({ selection_id: p.radio.selectionId, track: p.track, reasons: p.radio.reasons })))

export function createNativeQueueStore(plugin: PandaPlayerPlugin, initialVolume = 1): StoreApi<PlayerStoreState> {
  const send = (p: Promise<unknown>) => void p.catch(() => undefined)
  const store = createStore<PlayerStoreState>()((set, get) => ({
    items: [], index: -1, source: null, shuffle: false, ordered: null, repeat: 'off',
    status: 'idle', position: 0, duration: 0, error: null, volume: initialVolume, muted: false,

    playCollection(tracks: Track[], { startIndex, source = null, shuffle } = {}) {
      if (tracks.length) send(plugin.replaceQueue({ tracks: json(tracks), startIndex: startIndex ?? -1, source: json(source), shuffle: !!shuffle, play: true }))
    },
    restore(snapshot) {
      send(plugin.migrate({ snapshot: json(snapshot) }))
    },
    playNext: (tracks) => send(plugin.playNext({ tracks: json(tracks) })),
    addToQueue: (tracks) => send(plugin.addToQueue({ tracks: json(tracks) })),
    removeFromQueue: (uid) => send(plugin.remove({ uid })),
    clearQueue: (which = 'all') => send(plugin.clear({ which })),
    jumpTo: (uid) => send(plugin.jumpTo({ uid })),
    moveInQueue: (uid, direction) => send(plugin.move({ uid, direction })),
    toggleShuffle: () => send(plugin.toggleShuffle()),
    cycleRepeat: () => send(plugin.cycleRepeat()),
    togglePlay: () => send(get().status === 'playing' || get().status === 'loading' ? plugin.pause() : plugin.play()),
    play: () => send(plugin.play()),
    pause: () => send(plugin.pause()),
    seek: (seconds) => send(plugin.seek({ position: Math.max(0, seconds) })),
    next: () => send(plugin.next()),
    previous: () => send(plugin.previous()),
    setVolume(volume) {
      const v = Math.min(1, Math.max(0, volume))
      set({ volume: v, muted: v === 0 })
      send(plugin.setVolume({ volume: v }))
    },
    toggleMute() {
      const muted = !get().muted
      set({ muted })
      send(plugin.setVolume({ volume: muted ? 0 : get().volume || 1 }))
    },
    startRadio(picks, source, { seedTrack = null, keepCurrent = false } = {}) {
      send(plugin.applyRadio({ picks: picksOut(picks), source: json(source), seedTrack: json(seedTrack), keepCurrent, autoplay: false }))
    },
    addRadio() {
      // The playback service refills radio itself (it must, with the app closed).
    },
    continueWithRadio(picks, source) {
      send(plugin.applyRadio({ picks: picksOut(picks), source: json(source), seedTrack: 'null', keepCurrent: false, autoplay: true }))
    },
    endRadio: () => send(plugin.endRadio()),
  }))

  void plugin.addListener('queue', (e) => {
    const next = fromSnapshot(e.snapshot)
    if (next) store.setState(next)
  })
  void plugin.addListener('state', (e) => store.setState(fromState(e)))
  void plugin.getSnapshot().then((r) => {
    const next = fromSnapshot(r.snapshot)
    if (next) store.setState(next)
  }, () => undefined)
  return store
}
