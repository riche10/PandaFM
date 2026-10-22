import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Track } from '../api/library'
import { connectMediaSession, type MediaSessionLike, type MetadataInit } from './mediaSession.ts'
import { createPlayerStore } from './store.ts'
import type { EngineEvent, PlaybackEngine } from './types'

class QuietEngine implements PlaybackEngine {
  listeners = new Set<(e: EngineEvent) => void>()
  load() {}
  play() {
    return Promise.resolve()
  }
  pause() {}
  seek() {}
  stop() {}
  setVolume() {}
  subscribe(l: (e: EngineEvent) => void) {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

class FakeSession implements MediaSessionLike {
  metadata: unknown = null
  playbackState: 'none' | 'paused' | 'playing' = 'none'
  handlers = new Map<string, ((d: { seekTime?: number; seekOffset?: number }) => void) | null>()
  setActionHandler(action: string, handler: ((d: { seekTime?: number; seekOffset?: number }) => void) | null) {
    this.handlers.set(action, handler)
  }
  setPositionState() {}
}

const track = (id: string, cover: string | null = `al-${id}`): Track => ({
  id, title: `Song ${id}`, artist: 'Neon Panda', artist_id: null, album: 'Midnight Drive', album_id: null,
  cover_art_id: cover, duration_seconds: 100, track_number: null, disc_number: null, year: null, genres: [],
  content_type: null, suffix: null, bitrate_kbps: null, favorite: false,
})

function setup() {
  const store = createPlayerStore({ engine: new QuietEngine(), streamUrl: (id) => `/s/${id}`, explainError: async () => '' })
  const session = new FakeSession()
  connectMediaSession(store, session, (init) => init, (id, size) => `https://fm.example/api/covers/${id}?size=${size}`)
  return { store, session }
}

describe('media session', () => {
  it('shows the current song with artwork in several sizes', () => {
    const { store, session } = setup()
    assert.equal(session.metadata, null)
    store.getState().playCollection([track('a'), track('b')])
    const meta = session.metadata as unknown as MetadataInit
    assert.equal(meta.title, 'Song a')
    assert.equal(meta.artist, 'Neon Panda')
    assert.equal(meta.album, 'Midnight Drive')
    assert.deepEqual(meta.artwork.map((a) => a.sizes), ['96x96', '300x300', '600x600'])
    assert.equal(meta.artwork[0].src, 'https://fm.example/api/covers/al-a?size=96')
    assert.equal(session.playbackState, 'playing')
  })

  it('system buttons drive the shared queue', () => {
    const { store, session } = setup()
    store.getState().playCollection([track('a'), track('b')])
    session.handlers.get('nexttrack')!({})
    assert.equal((session.metadata as MetadataInit).title, 'Song b')
    session.handlers.get('pause')!({})
    assert.equal(session.playbackState, 'paused')
    session.handlers.get('seekto')!({ seekTime: 42 })
    assert.equal(store.getState().position, 42)
  })

  it('hides "next" at the end of the queue and offers it again when songs are added', () => {
    const { store, session } = setup()
    store.getState().playCollection([track('a')])
    assert.equal(session.handlers.get('nexttrack'), null)
    store.getState().addToQueue([track('b')])
    assert.equal(typeof session.handlers.get('nexttrack'), 'function')
  })
})
