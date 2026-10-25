import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { catalogOf } from './catalog.ts'

describe('offline catalogue for the playback service', () => {
  it('lists only finished downloads with their local files, plus collections', () => {
    const base = { track: { id: 'a' }, refs: [] }
    const c = catalogOf({
      tracks: {
        a: { ...base, trackId: 'a', status: 'downloaded', localUri: 'content://x/a' } as never,
        b: { ...base, trackId: 'b', track: { id: 'b' }, status: 'downloading', localUri: null } as never,
        c: { ...base, trackId: 'c', track: { id: 'c' }, status: 'outdated', localUri: 'content://x/c' } as never,
      },
      collections: { 'playlist:p': { key: 'playlist:p', kind: 'playlist', id: 'p', name: 'Mix', trackIds: ['a', 'c'], coverArtId: 'pc' } as never },
      artwork: { pc: 'content://x/cover' },
    })
    assert.deepEqual(c.tracks.map((t) => t.uri), ['content://x/a', 'content://x/c'])
    assert.deepEqual(c.collections[0], { key: 'playlist:p', kind: 'playlist', id: 'p', name: 'Mix', trackIds: ['a', 'c'], coverArtId: 'pc' })
    assert.equal(JSON.stringify(c).includes('token'), false)
  })
})
