import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Track } from '../api/library'
import type { EngineEvent, PlaybackEngine, PlaybackErrorKind, PlaybackStatus } from './types'

// The single source of truth for "what is playing". React components read it
// through usePlayer() and call its actions; only the store talks to the
// engine. Stage 2's queue is simply the list a song was picked from (an
// album, or search results). Panda Radio will feed the same queue later.

export interface PlayerState {
  queue: Track[]
  index: number // -1 when nothing has been picked
  status: PlaybackStatus
  position: number
  duration: number
  error: string | null
}

export interface PlayerActions {
  playTracks(tracks: Track[], startIndex?: number): void
  togglePlay(): void
  play(): void
  pause(): void
  seek(seconds: number): void
  next(): void
  previous(): void
}

export type PlayerStoreState = PlayerState & PlayerActions
export type PlayerStore = StoreApi<PlayerStoreState>

export interface PlayerDeps {
  engine: PlaybackEngine
  streamUrl: (trackId: string) => string
  /** Find out why a track failed (e.g. ask the API), returning a readable message. */
  explainError: (trackId: string, kind: PlaybackErrorKind) => Promise<string>
}

export const PLAYBACK_ERROR_MESSAGES: Record<PlaybackErrorKind, string> = {
  network: 'The connection dropped while this song was loading.',
  decode: 'This file is damaged, or in a format this browser can’t decode.',
  unsupported: 'This browser can’t play this file’s format.',
  unknown: 'This song couldn’t be played.',
}

/** Pressing "previous" this far into a song restarts it instead. */
const RESTART_THRESHOLD_SECONDS = 3

export function currentTrack(state: PlayerState): Track | null {
  return state.queue[state.index] ?? null
}

export function createPlayerStore({ engine, streamUrl, explainError }: PlayerDeps): PlayerStore {
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

    const start = (index: number) => {
      const track = get().queue[index]
      if (!track) return
      set({
        index,
        status: 'loading',
        position: 0,
        duration: track.duration_seconds ?? 0,
        error: null,
      })
      engine.load(streamUrl(track.id))
      startPlayback()
    }

    return {
      queue: [],
      index: -1,
      status: 'idle',
      position: 0,
      duration: 0,
      error: null,

      playTracks(tracks, startIndex = 0) {
        if (tracks.length === 0) return
        set({ queue: tracks })
        start(Math.min(Math.max(0, startIndex), tracks.length - 1))
      },

      togglePlay() {
        const { status } = get()
        if (status === 'playing' || status === 'loading') get().pause()
        else get().play()
      },

      play() {
        const { status, index } = get()
        if (index < 0) return
        if (status === 'error') {
          start(index) // try again from the top
          return
        }
        if (status === 'ended') engine.seek(0)
        if (status !== 'playing') set({ status: 'loading' }) // until audio actually flows
        startPlayback()
      },

      pause() {
        engine.pause()
        set({ status: 'paused' })
      },

      seek(seconds) {
        const { duration, index } = get()
        if (index < 0) return
        const target = Math.min(Math.max(0, seconds), duration > 0 ? duration : seconds)
        set({ position: target })
        engine.seek(target)
      },

      next() {
        const { index, queue } = get()
        if (index + 1 < queue.length) start(index + 1)
      },

      previous() {
        const { index, position } = get()
        if (index < 0) return
        if (position > RESTART_THRESHOLD_SECONDS || index === 0) get().seek(0)
        else start(index - 1)
      },
    }
  })

  const onEngineEvent = (event: EngineEvent) => {
    const state = store.getState()
    switch (event.type) {
      case 'loading':
        if (state.status !== 'paused') store.setState({ status: 'loading' })
        break
      case 'playing':
        store.setState({ status: 'playing', error: null })
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
        if (state.index + 1 < state.queue.length) state.next()
        else store.setState({ status: 'ended', position: state.duration })
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

  engine.subscribe(onEngineEvent)
  return store
}
