import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { FavoriteKind, Playlist } from '../api/library'
import { createFavoritesStore, isFavorite } from './favorites.ts'
import { createPlaylistsStore } from './playlists.ts'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('favorites store', () => {
  it('flips the heart at once and keeps it when Navidrome agrees', async () => {
    const calls: [FavoriteKind, string, boolean][] = []
    const messages: string[] = []
    const store = createFavoritesStore({
      setFavorite: async (...args) => void calls.push(args),
      notify: (message) => void messages.push(message),
    })

    const pending = store.getState().toggle('track', 't1', false)
    assert.equal(isFavorite(store.getState(), 'track', 't1', false), true) // before the API answers
    await pending

    assert.deepEqual(calls, [['track', 't1', true]])
    assert.equal(store.getState().version, 1)
    assert.deepEqual(messages, ['Added to Favorites'])
  })

  it('rolls back and reports when Navidrome refuses', async () => {
    const messages: string[] = []
    const store = createFavoritesStore({
      setFavorite: async () => {
        throw new Error('Navidrome isn’t responding.')
      },
      notify: (message, tone) => void messages.push(`${tone}: ${message}`),
    })

    await store.getState().toggle('album', 'a1', true)
    assert.equal(isFavorite(store.getState(), 'album', 'a1', true), true) // back to the original
    assert.equal(store.getState().version, 0)
    assert.deepEqual(messages, ['error: Navidrome isn’t responding.'])
  })

  it('falls back to what the server said for untouched items', () => {
    const store = createFavoritesStore({ setFavorite: async () => {}, notify: () => {} })
    assert.equal(isFavorite(store.getState(), 'artist', 'x', true), true)
    assert.equal(isFavorite(store.getState(), 'artist', 'x', false), false)
  })
})

const playlist = (id: string, name: string, trackIds: string[] = []): Playlist => ({
  id,
  name,
  track_count: trackIds.length,
  duration_seconds: null,
  cover_art_id: null,
  owner: 'panda',
  readonly: false,
  tracks: [],
})

describe('playlists store', () => {
  it('keeps the shared list in step with every change', async () => {
    const store = createPlaylistsStore({
      list: async () => ({ playlists: [playlist('p1', 'Old')] }),
      create: async (name, ids) => playlist('p2', name, ids),
      rename: async (id, name) => playlist(id, name),
      remove: async () => null,
      addTracks: async (id) => ({ ...playlist(id, 'Old'), track_count: 2 }),
      removeTrack: async (id) => playlist(id, 'Old'),
    })

    await store.getState().load()
    await store.getState().create('New mix', ['a', 'b'])
    await store.getState().rename('p1', 'Renamed')
    await store.getState().addTracks('p1', ['c', 'd'])
    assert.deepEqual(
      store.getState().playlists.map((p) => [p.id, p.name, p.track_count]),
      [
        ['p2', 'New mix', 2],
        ['p1', 'Old', 2],
      ],
    )
    assert.equal('tracks' in store.getState().playlists[0], false) // summaries only

    await store.getState().remove('p2')
    assert.deepEqual(store.getState().playlists.map((p) => p.id), ['p1'])
    assert.equal(store.getState().version, 4)
  })

  it('reports a failed first load without losing a later good one', async () => {
    let fail = true
    const store = createPlaylistsStore({
      list: async () => {
        if (fail) throw new Error('down')
        return { playlists: [playlist('p1', 'Mix')] }
      },
      create: async () => playlist('x', 'x'),
      rename: async () => playlist('x', 'x'),
      remove: async () => null,
      addTracks: async () => playlist('x', 'x'),
      removeTrack: async () => playlist('x', 'x'),
    })
    await store.getState().load()
    assert.equal(store.getState().status, 'error')
    fail = false
    await store.getState().load()
    assert.equal(store.getState().status, 'ready')
    await flush()
  })
})
