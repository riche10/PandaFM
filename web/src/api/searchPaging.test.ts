import assert from 'node:assert/strict'
import { it, suite } from 'node:test'
import { loadAllSongs } from './library.ts'

// 5.5.2: "Show all" must expose every matching song (search used to stop at 20).
const song = (k: number) => ({ id: `cs${k}`, title: `Cyber Space ${k}` }) as never
function server(total: number, pageSize: number) {
  const calls: number[] = []
  const page = async (offset: number) => {
    calls.push(offset)
    const tracks = Array.from({ length: Math.max(0, Math.min(pageSize, total - offset)) }, (_, i) => song(offset + i))
    return { tracks, tracks_has_more: offset + pageSize < total }
  }
  return { page, calls }
}

suite('5.5.2 search: Show all loads every song', () => {
  it('all 28 Cyber Space songs, in order, after a 20-song first page', async () => {
    const s = server(28, 20)
    const r = await loadAllSongs(await s.page(0), s.page)
    assert.deepEqual(r.tracks.map((t) => t.id), Array.from({ length: 28 }, (_, k) => `cs${k}`))
    assert.equal(r.complete, true)
    assert.deepEqual(s.calls, [0, 20])
  })

  it('more than 50 matches: the 51st and later are reachable', async () => {
    const s = server(75, 50)
    const r = await loadAllSongs(await s.page(0), s.page)
    assert.equal(r.tracks.length, 75)
    assert.equal(r.tracks[50].id, 'cs50')
    assert.equal(new Set(r.tracks.map((t) => t.id)).size, 75)
  })

  it('a first page that is already complete makes no more requests', async () => {
    const s = server(12, 50)
    const r = await loadAllSongs(await s.page(0), s.page)
    assert.equal(r.tracks.length, 12)
    assert.deepEqual(s.calls, [0])
  })

  it('stops at the safety cap and says it is not complete', async () => {
    const s = server(500, 50)
    const r = await loadAllSongs(await s.page(0), s.page, 120)
    assert.ok(r.tracks.length >= 120 && r.tracks.length < 500)
    assert.equal(r.complete, false)
  })

  it('a song repeated by a shifting page is kept once; an empty page ends it', async () => {
    const first = { tracks: [song(0), song(1)], tracks_has_more: true }
    const pages: Record<number, { tracks: never[]; tracks_has_more: boolean }> = { 2: { tracks: [song(1), song(2)], tracks_has_more: true }, 4: { tracks: [], tracks_has_more: true } }
    const r = await loadAllSongs(first, async (offset) => pages[offset] ?? { tracks: [], tracks_has_more: false })
    assert.deepEqual(r.tracks.map((t) => t.id), ['cs0', 'cs1', 'cs2'])
  })
})
