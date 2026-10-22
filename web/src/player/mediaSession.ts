import { currentTrack, hasNext, type PlayerStore, type PlayerStoreState } from './store.ts'

// Android's media notification and lock screen (and desktop media keys) via
// the Media Session API. It only mirrors the player store and calls its
// actions, so system buttons follow the same shared queue as on-screen ones.
// Chrome offers navigator.mediaSession on HTTPS pages; elsewhere the browser
// keeps its own basic notification and this is never connected.

export interface MediaSessionLike {
  metadata: unknown
  playbackState: 'none' | 'paused' | 'playing'
  setActionHandler(action: string, handler: ((details: { seekTime?: number; seekOffset?: number }) => void) | null): void
  setPositionState?(state: { duration: number; position: number; playbackRate: number }): void
}

export interface MetadataInit {
  title: string
  artist: string
  album: string
  artwork: { src: string; sizes: string }[]
}

const ARTWORK_SIZES = [96, 300, 600] as const
const SKIP_SECONDS = 10

export function connectMediaSession(
  store: PlayerStore,
  session: MediaSessionLike,
  makeMetadata: (init: MetadataInit) => unknown,
  artworkUrl: (coverArtId: string, size: number) => string,
): () => void {
  const act = (fn: (s: PlayerStoreState) => void) => () => fn(store.getState())
  const setHandler: MediaSessionLike['setActionHandler'] = (action, handler) => {
    try {
      session.setActionHandler(action, handler)
    } catch {
      // This browser doesn't support that action; the others still work.
    }
  }

  setHandler('play', act((s) => s.play()))
  setHandler('pause', act((s) => s.pause()))
  setHandler('stop', act((s) => s.pause()))
  setHandler('previoustrack', act((s) => s.previous()))
  setHandler('seekto', (details) => {
    if (details.seekTime !== undefined) store.getState().seek(details.seekTime)
  })
  setHandler('seekbackward', (details) => {
    const s = store.getState()
    s.seek(s.position - (details.seekOffset ?? SKIP_SECONDS))
  })
  setHandler('seekforward', (details) => {
    const s = store.getState()
    s.seek(s.position + (details.seekOffset ?? SKIP_SECONDS))
  })

  let trackId: string | null | undefined
  let nextShown: boolean | undefined
  let lastPositionSync = 0

  const sync = (state: PlayerStoreState, previous?: PlayerStoreState) => {
    const track = currentTrack(state)
    if ((track?.id ?? null) !== trackId) {
      trackId = track?.id ?? null
      session.metadata = track
        ? makeMetadata({
            title: track.title,
            artist: track.artist,
            album: track.album ?? '',
            artwork: track.cover_art_id
              ? ARTWORK_SIZES.map((size) => ({ src: artworkUrl(track.cover_art_id!, size), sizes: `${size}x${size}` }))
              : [],
          })
        : null
    }

    session.playbackState = state.status === 'playing' || state.status === 'loading' ? 'playing' : state.index >= 0 ? 'paused' : 'none'

    // Only offer "next" when the queue has somewhere to go.
    const canAdvance = hasNext(state)
    if (canAdvance !== nextShown) {
      nextShown = canAdvance
      setHandler('nexttrack', canAdvance ? act((s) => s.next()) : null)
    }

    // The system draws its own progress bar from this; refresh on seeks and every few seconds.
    const jumped = previous && Math.abs(state.position - previous.position) > 2
    const now = Date.now()
    if (session.setPositionState && state.duration > 0 && (jumped || now - lastPositionSync > 5000 || state.status !== previous?.status)) {
      lastPositionSync = now
      try {
        session.setPositionState({ duration: state.duration, position: Math.min(state.position, state.duration), playbackRate: 1 })
      } catch {
        // Ignore an inconsistent moment (e.g. a duration not known yet).
      }
    }
  }

  sync(store.getState())
  const unsubscribe = store.subscribe(sync)
  return unsubscribe
}
