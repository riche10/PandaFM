import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Track } from '../api/library'
import * as Q from './queue.ts'
import type { EngineEvent, PlaybackEngine, PlaybackErrorKind, PlaybackStatus } from './types'

// The single source of truth for "what is playing". React components read it
// through usePlayer() and call its actions; only the store talks to the
// engine. The queue itself (order, shuffle, repeat, hand-picked songs) is
// plain data managed by ./queue; this store applies it and drives playback.

export interface PlayerState extends Q.QueueState {
  status: PlaybackStatus
  position: number
  duration: number
  error: string | null
  volume: number // 0–1, kept while muted
  muted: boolean
}

export interface PlayOptions {
  /** Which song to start with; omitted with shuffle means a random one. */
  startIndex?: number
  source?: Q.QueueSource | null
  shuffle?: boolean
}

/** What the store reports as playback happens; player/index.ts turns these into API events. */
export interface PlaybackReport {
  type: 'play_started' | 'play_completed' | 'skip' | 'pause' | 'resume' | 'seek'
  item: Q.QueueItem
  playId: string
  position: number
  duration: number
  source: Q.QueueSource | null
  details?: Record<string, unknown>
}

export interface PlayerActions {
  /** Replace the queue with a collection (album, playlist, results…) and play it. */
  playCollection(tracks: Track[], options?: PlayOptions): void
  playNext(tracks: Track[]): void
  addToQueue(tracks: Track[]): void
  removeFromQueue(uid: string): void
  clearQueue(which?: 'all' | 'manual'): void
  jumpTo(uid: string): void
  moveInQueue(uid: string, direction: -1 | 1): void
  toggleShuffle(): void
  cycleRepeat(): void
  togglePlay(): void
  play(): void
  pause(): void
  seek(seconds: number): void
  next(): void
  previous(): void
  setVolume(volume: number): void
  toggleMute(): void
  /** Panda Radio: replace the queue with radio picks (or follow the current song). */
  startRadio(picks: Q.RadioPickInput[], source: Q.QueueSource, options?: { seedTrack?: Track | null; keepCurrent?: boolean }): void
  /** Panda Radio: drop replaced upcoming picks and add new ones. */
  addRadio(replaced: number[], picks: Q.RadioPickInput[]): void
  endRadio(): void
}

export type PlayerStoreState = PlayerState & PlayerActions
export type PlayerStore = StoreApi<PlayerStoreState>

export interface PlayerDeps {
  engine: PlaybackEngine
  streamUrl: (trackId: string) => string
  /** Find out why a track failed (e.g. ask the API), returning a readable message. */
  explainError: (trackId: string, kind: PlaybackErrorKind) => Promise<string>
  initialVolume?: number
  random?: Q.Random
  /** Listening behaviour, reported centrally from here (see player/events.ts). */
  report?: (event: PlaybackReport) => void
  newId?: () => string
}

export const PLAYBACK_ERROR_MESSAGES: Record<PlaybackErrorKind, string> = {
  network: 'The connection dropped while this song was loading.',
  decode: 'This file is damaged, or in a format this browser can’t decode.',
  unsupported: 'This browser can’t play this file’s format.',
  unknown: 'This song couldn’t be played.',
}

/** Pressing "previous" this far into a song restarts it instead. */
const RESTART_THRESHOLD_SECONDS = 3

export function currentTrack(state: Pick<PlayerState, 'items' | 'index'>): Track | null {
  return state.items[state.index]?.track ?? null
}

export const hasNext = (state: PlayerState) => Q.nextIndex(state) !== null

function queueOf(state: PlayerState): Q.QueueState {
  const { items, index, source, shuffle, ordered, repeat } = state
  return { items, index, source, shuffle, ordered, repeat }
}

export function createPlayerStore({
  engine,
  streamUrl,
  explainError,
  initialVolume = 1,
  random = Math.random,
  report,
  newId = () => Math.random().toString(36).slice(2),
}: PlayerDeps): PlayerStore {
  engine.setVolume(initialVolume)

  // The listen in progress: one play_id ties together its events.
  let listen: { playId: string; uid: string; started: boolean; completed: boolean; paused: boolean } | null = null

  const store = createStore<PlayerStoreState>()((set, get) => {
    const startPlayback = () => {
      engine.play().catch((err: unknown) => {
        if (!(err instanceof DOMException)) return
        // A newer load() interrupted this one; the new song takes over.
        if (err.name === 'AbortError') return
        // Autoplay policy: the browser wants a tap before sound starts.
        if (err.name === 'NotAllowedError') set({ status: 'paused' })
        // Real playback failures arrive as engine 'error' events.
      })
    }

    const emit = (type: PlaybackReport['type'], details?: Record<string, unknown>, position?: number) => {
      const state = get()
      const item = state.items.find((i) => i.uid === listen?.uid)
      if (!listen || !item || !report) return
      report({
        type,
        item,
        playId: listen.playId,
        position: position ?? state.position,
        duration: state.duration || item.track.duration_seconds || 0,
        source: state.source,
        details,
      })
    }

    /** Make queue position `index` current and start it from the top. */
    const start = (index: number) => {
      const item = get().items[index]
      if (!item) return
      // Leaving a song that started but didn't finish is a skip (early or late is decided by the server).
      if (listen?.started && !listen.completed) emit('skip')
      listen = { playId: newId(), uid: item.uid, started: false, completed: false, paused: false }
      set({
        index,
        status: 'loading',
        position: 0,
        duration: item.track.duration_seconds ?? 0,
        error: null,
      })
      engine.load(streamUrl(item.track.id))
      startPlayback()
    }

    const update = (change: (queue: Q.QueueState) => Q.QueueState) => set(change(queueOf(get())))

    /** Hand-picked songs added with nothing loaded: show the first one, ready to play. */
    const showFirstIfIdle = () => {
      if (get().status === 'idle') set({ duration: currentTrack(get())?.duration_seconds ?? 0 })
    }

    return {
      ...Q.emptyQueue,
      status: 'idle',
      position: 0,
      duration: 0,
      error: null,
      volume: initialVolume,
      muted: false,

      playCollection(tracks, { startIndex, source = null, shuffle } = {}) {
        if (tracks.length === 0) return
        update((q) => Q.load(q, tracks, { startIndex, source, shuffle, random }))
        start(get().index)
      },

      playNext(tracks) {
        update((q) => Q.playNext(q, tracks))
        showFirstIfIdle()
      },

      addToQueue(tracks) {
        update((q) => Q.addToQueue(q, tracks))
        showFirstIfIdle()
      },

      removeFromQueue: (uid) => update((q) => Q.remove(q, uid)),
      clearQueue: (which = 'all') => update((q) => Q.clearUpcoming(q, which)),
      moveInQueue: (uid, direction) => update((q) => Q.move(q, uid, direction)),
      toggleShuffle: () => update((q) => Q.setShuffle(q, !q.shuffle, random)),
      cycleRepeat: () => update(Q.cycleRepeat),

      jumpTo(uid) {
        update((q) => Q.jumpTo(q, uid))
        start(get().index)
      },

      togglePlay() {
        const { status } = get()
        if (status === 'playing' || status === 'loading') get().pause()
        else get().play()
      },

      play() {
        const { status, index } = get()
        if (index < 0) return
        // Queued but never started, or failed: (re)load the current song.
        if (status === 'error' || status === 'idle') {
          start(index)
          return
        }
        if (status === 'ended') engine.seek(0)
        if (status !== 'playing') set({ status: 'loading' }) // until audio actually flows
        startPlayback()
      },

      pause() {
        const { status } = get()
        if (listen?.started && !listen.paused && (status === 'playing' || status === 'loading')) {
          emit('pause')
          listen.paused = true
        }
        engine.pause()
        set({ status: 'paused' })
      },

      seek(seconds) {
        const { duration, index } = get()
        if (index < 0) return
        const target = Math.min(Math.max(0, seconds), duration > 0 ? duration : seconds)
        const from = get().position
        set({ position: target })
        engine.seek(target)
        if (listen?.started) emit('seek', { from: Math.round(from * 10) / 10 }, target)
      },

      next() {
        const target = Q.nextIndex(get())
        if (target !== null) start(target)
      },

      previous() {
        const state = get()
        if (state.index < 0) return
        const target = Q.previousIndex(state)
        if (state.position > RESTART_THRESHOLD_SECONDS || target === null) state.seek(0)
        else start(target)
      },

      setVolume(volume) {
        const clamped = Math.min(Math.max(0, volume), 1)
        set({ volume: clamped, muted: clamped === 0 })
        engine.setVolume(clamped)
      },

      toggleMute() {
        const { muted, volume } = get()
        // Unmuting from zero restores a sensible level instead of silence.
        const restored = volume > 0 ? volume : 0.5
        set(muted ? { muted: false, volume: restored } : { muted: true })
        engine.setVolume(muted ? restored : 0)
      },

      startRadio(picks, source, options = {}) {
        const keepCurrent = Boolean(options.keepCurrent && get().index >= 0)
        update((q) => Q.startRadio(q, picks, source, { ...options, keepCurrent }))
        if (!keepCurrent) start(0)
      },

      addRadio: (replaced, picks) => update((q) => Q.addRadio(q, replaced, picks)),
      endRadio: () => update(Q.endRadio),
    }
  })

  const onEngineEvent = (event: EngineEvent) => {
    const state = store.getState()
    switch (event.type) {
      case 'loading':
        if (state.status !== 'paused') store.setState({ status: 'loading' })
        break
      case 'playing':
        if (listen && !listen.started) {
          listen.started = true
          store.setState({ status: 'playing', error: null })
          reportFrom('play_started', 0)
        } else {
          store.setState({ status: 'playing', error: null })
          if (listen?.paused) {
            listen.paused = false
            reportFrom('resume')
          }
        }
        break
      case 'paused':
        // While a new song loads the old source can report a pause; ignore it.
        if (state.status !== 'loading') store.setState({ status: 'paused' })
        break
      case 'time':
        store.setState({
          position: event.position,
          duration: event.duration ?? state.duration,
        })
        break
      case 'ended':
        if (listen?.started && !listen.completed) {
          reportFrom('play_completed', state.duration)
          listen.completed = true
        }
        if (state.repeat === 'one') {
          engine.seek(0)
          startAgain(state)
        } else if (Q.nextIndex(state) !== null) {
          state.next()
        } else {
          store.setState({ status: 'ended', position: state.duration })
        }
        break
      case 'error': {
        const track = currentTrack(state)
        store.setState({ status: 'error', error: PLAYBACK_ERROR_MESSAGES[event.kind] })
        if (!track) break
        void explainError(track.id, event.kind).then((message) => {
          const now = store.getState()
          // Only if the user is still looking at the same failed song.
          if (now.status === 'error' && currentTrack(now)?.id === track.id) {
            store.setState({ error: message })
          }
        })
        break
      }
    }
  }

  function reportFrom(type: PlaybackReport['type'], position?: number) {
    const state = store.getState()
    const item = state.items.find((i) => i.uid === listen?.uid)
    if (!listen || !item || !report) return
    report({
      type,
      item,
      playId: listen.playId,
      position: position ?? state.position,
      duration: state.duration || item.track.duration_seconds || 0,
      source: state.source,
    })
  }

  /** Repeat-one: the song ended, so play it again from the top (a new listen). */
  const startAgain = (state: PlayerStoreState) => {
    if (listen) listen = { ...listen, playId: newId(), started: false, completed: false, paused: false }
    store.setState({ status: 'loading', position: 0 })
    engine.play().catch(() => state.pause())
  }

  engine.subscribe(onEngineEvent)
  return store
}
