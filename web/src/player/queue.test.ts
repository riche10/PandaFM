import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Track } from '../api/library'
import {
  addToQueue,
  clearUpcoming,
  contextUpcoming,
  current,
  cycleRepeat,
  emptyQueue,
  jumpTo,
  load,
  manualUpcoming,
  move,
  nextIndex,
  playNext,
  previousIndex,
  type QueueState,
  remove,
  setShuffle,
  upcoming,
} from './queue.ts'

const track = (id: string): Track => ({
  id,
  title: id,
  artist: 'Neon Panda',
  artist_id: null,
  album: null,
  album_id: null,
  cover_art_id: null,
  duration_seconds: 100,
  track_number: null,
  disc_number: null,
  year: null,
  genres: [],
  content_type: null,
  suffix: null,
  bitrate_kbps: null,
  favorite: false,
})

const album = ['a', 'b', 'c', 'd', 'e', 'f'].map(track)
const ids = (state: QueueState) => state.items.map((item) => item.track.id)
const now = (state: QueueState) => current(state)?.track.id
/** Deterministic "random" numbers for repeatable shuffles. */
const seeded = (seed = 7) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

describe('loading a collection', () => {
  it('starts at the chosen song with the rest of the album queued', () => {
    const q = load(emptyQueue, album, { startIndex: 2, source: { kind: 'album', name: 'Midnight Drive' } })
    assert.equal(now(q), 'c')
    assert.deepEqual(upcoming(q).map((i) => i.track.id), ['d', 'e', 'f'])
    assert.equal(q.source?.name, 'Midnight Drive')
  })

  it('shuffle-play keeps every song exactly once', () => {
    const q = load(emptyQueue, album, { shuffle: true, random: seeded() })
    assert.equal(q.shuffle, true)
    assert.equal(q.index, 0)
    assert.deepEqual([...ids(q)].sort(), ['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('ignores an empty collection', () => {
    assert.equal(load(emptyQueue, []), emptyQueue)
  })
})

describe('hand-picked songs', () => {
  const base = () => load(emptyQueue, album, { startIndex: 0 })

  it('Play next goes straight after the current song, ahead of earlier picks', () => {
    let q = playNext(base(), [track('x')])
    q = playNext(q, [track('y')])
    assert.deepEqual(ids(q).slice(0, 4), ['a', 'y', 'x', 'b'])
    assert.deepEqual(manualUpcoming(q).map((i) => i.track.id), ['y', 'x'])
  })

  it('Add to queue goes after earlier picks, before the rest of the album', () => {
    let q = addToQueue(base(), [track('x')])
    q = addToQueue(q, [track('y')])
    assert.deepEqual(ids(q).slice(0, 4), ['a', 'x', 'y', 'b'])
    assert.equal(contextUpcoming(q)[0].track.id, 'b')
  })

  it('the same song can be queued twice and removed one at a time', () => {
    let q = addToQueue(base(), [track('x'), track('x')])
    const [first] = manualUpcoming(q)
    q = remove(q, first.uid)
    assert.deepEqual(ids(q).filter((id) => id === 'x'), ['x'])
  })

  it('queuing with nothing loaded makes the first song current', () => {
    const q = addToQueue(emptyQueue, [track('x'), track('y')])
    assert.equal(now(q), 'x')
  })
})

describe('editing the queue', () => {
  it('removing an earlier song keeps the current one current; the current one cannot be removed', () => {
    let q = load(emptyQueue, album, { startIndex: 3 })
    q = remove(q, q.items[1].uid)
    assert.equal(now(q), 'd')
    assert.equal(remove(q, current(q)!.uid), q)
  })

  it('clear removes upcoming songs only', () => {
    let q = playNext(load(emptyQueue, album, { startIndex: 2 }), [track('x')])
    assert.deepEqual(ids(clearUpcoming(q, 'manual')), ['a', 'b', 'c', 'd', 'e', 'f'])
    q = clearUpcoming(q)
    assert.deepEqual(ids(q), ['a', 'b', 'c'])
    assert.equal(nextIndex(q), null)
  })

  it('jumps to an upcoming song', () => {
    const q = load(emptyQueue, album)
    assert.equal(now(jumpTo(q, q.items[4].uid)), 'e')
  })

  it('reorders upcoming songs but never past the current one', () => {
    const q = load(emptyQueue, album, { startIndex: 1 })
    const moved = move(q, q.items[3].uid, -1)
    assert.deepEqual(ids(moved), ['a', 'b', 'd', 'c', 'e', 'f'])
    assert.equal(move(q, q.items[2].uid, -1), q) // would jump above the current song
  })

  it('moving a song into the hand-picked block makes it hand-picked', () => {
    const q = addToQueue(load(emptyQueue, album), [track('x')])
    const b = q.items[2]
    const moved = move(q, b.uid, -1)
    assert.deepEqual(manualUpcoming(moved).map((i) => i.track.id), ['b', 'x'])
  })
})

describe('shuffle', () => {
  it('keeps the current song playing and puts hand-picked songs next', () => {
    let q = load(emptyQueue, album, { startIndex: 2 })
    q = addToQueue(q, [track('x')])
    q = setShuffle(q, true, seeded())
    assert.equal(now(q), 'c')
    assert.equal(manualUpcoming(q)[0].track.id, 'x')
    assert.deepEqual([...ids(q)].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'x'])
  })

  it('does not change the album or playlist it came from', () => {
    const tracks = [...album]
    setShuffle(load(emptyQueue, tracks), true, seeded())
    assert.deepEqual(tracks.map((t) => t.id), ['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('turning it off restores the original order around the current song', () => {
    let q = load(emptyQueue, album, { startIndex: 0 })
    q = setShuffle(q, true, seeded(3))
    q = jumpTo(q, q.items[3].uid) // listen a while in shuffled order
    const playing = now(q)
    q = addToQueue(q, [track('x')])
    q = setShuffle(q, false)
    assert.equal(now(q), playing)
    assert.deepEqual(ids(q).filter((id) => id !== 'x'), ['a', 'b', 'c', 'd', 'e', 'f'])
    assert.equal(upcoming(q)[0].track.id, 'x') // hand-picked still next
    assert.equal(q.ordered, null)
  })

  it('removed songs stay removed after unshuffling', () => {
    let q = setShuffle(load(emptyQueue, album), true, seeded())
    const gone = upcoming(q)[0]
    q = setShuffle(remove(q, gone.uid), false)
    assert.equal(ids(q).includes(gone.track.id), false)
    assert.equal(ids(q).length, 5)
  })

  it('a song moved into the picks is not duplicated when unshuffling', () => {
    let q = addToQueue(setShuffle(load(emptyQueue, album), true, seeded()), [track('x')])
    q = move(q, q.items[2].uid, -1) // first shuffled song joins the picks
    q = setShuffle(q, false)
    assert.equal(ids(q).length, 7)
    assert.equal(new Set(q.items.map((i) => i.uid)).size, 7)
  })
})

describe('next, previous and repeat', () => {
  it('stops at the end unless repeating everything', () => {
    let q = load(emptyQueue, album, { startIndex: 5 })
    assert.equal(nextIndex(q), null)
    q = cycleRepeat(q) // all
    assert.equal(nextIndex(q), 0)
    assert.equal(q.repeat, 'all')
    assert.equal(cycleRepeat(cycleRepeat(q)).repeat, 'off') // all -> one -> off
  })

  it('previous goes back, or wraps with repeat-all, or has nowhere to go', () => {
    const q = load(emptyQueue, album, { startIndex: 0 })
    assert.equal(previousIndex(q), null)
    assert.equal(previousIndex({ ...q, repeat: 'all' }), 5)
    assert.equal(previousIndex(load(emptyQueue, album, { startIndex: 3 })), 2)
  })
})
