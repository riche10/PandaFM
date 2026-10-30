import assert from 'node:assert/strict'
import { it, suite } from 'node:test'
import { createLatest } from './latest.ts'
import { type QueueState, reorderUpcoming, updateMix } from './queue.ts'

// 5.5.2: Panda Mix live edits: the same rule as Android's QueueController.reorderUpcoming().
const item = (id: string, uid = id, origin: 'context' | 'manual' = 'context') => ({ uid, origin, track: { id, title: id } }) as never
const state = (ids: string[], index = 0, extra: Partial<QueueState> = {}): QueueState => ({
  items: ids.map((id, k) => item(id, `${id}#${k}`)), index, shuffle: false, ordered: null, repeat: 'off',
  source: { kind: 'playlist', name: 'Mix', mix: { mode: 'auto', playlistId: 'p1' } } as never, ...extra,
})
const ids = (s: QueueState) => s.items.map((i) => i.track.id)

suite('5.5.2 Panda Mix live edits (queue)', () => {
  it('a new mode changes only the source: the current song and the order stay', () => {
    const s = state(['a', 'b', 'c'])
    const next = updateMix(s, 'p1', { mode: 'energetic' })!
    assert.equal((next.source as never as { mix: { mode: string } }).mix.mode, 'energetic')
    assert.equal(next.items, s.items)
    assert.equal(next.index, 0)
  })

  it('a Remix reorders only the upcoming songs, wrapping around after the current one', () => {
    const s = state(['a', 'b', 'c', 'd', 'e'])
    const next = updateMix(s, 'p1', { order: ['c', 'a', 'e', 'b', 'd'] })!
    assert.deepEqual(ids(next), ['a', 'e', 'b', 'd', 'c'])
    assert.equal(next.items[0], s.items[0]) // the playing item itself
    assert.equal(new Set(next.items).size, 5)
  })

  it('duplicates stay separate occurrences; hand-added songs stay after the mix', () => {
    const s = state(['a', 'b', 'a', 'c'])
    const next = updateMix(s, 'p1', { order: ['a', 'c', 'a', 'b'] })!
    assert.deepEqual(ids(next), ['a', 'c', 'a', 'b'])
    assert.equal(next.items[2], s.items[2]) // the later A keeps its own item
    const withManual = { ...state(['a', 'b', 'c']), items: [item('a', 'a#0'), item('x', 'x#m', 'manual'), item('b', 'b#1'), item('c', 'c#2')] }
    assert.deepEqual(ids(updateMix(withManual, 'p1', { order: ['a', 'c', 'b'] })!), ['a', 'c', 'b', 'x'])
  })

  it('another playlist, or nothing playing: null (applies next time); shuffled: the mode only', () => {
    assert.equal(updateMix(state(['a', 'b']), 'other', { mode: 'gentle' }), null)
    assert.equal(updateMix(state([], -1), 'p1', { mode: 'gentle' }), null)
    const shuffled = updateMix(state(['a', 'b', 'c'], 0, { shuffle: true }), 'p1', { mode: 'flow', order: ['a', 'c', 'b'] })!
    assert.deepEqual(ids(shuffled), ['a', 'b', 'c'])
    assert.equal((shuffled.source as never as { mix: { mode: string } }).mix.mode, 'flow')
  })

  it('keep: a committed next song (a blend under way) stays put', () => {
    assert.deepEqual(reorderUpcoming(['a', 'b', 'c', 'd'], 0, ['a', 'd', 'c', 'b'], (x) => x, 1), ['a', 'b', 'd', 'c'])
  })

  it('rapid changes: only the latest choice applies, whatever order the answers arrive in', async () => {
    const latest = createLatest()
    const applied: string[] = []
    const resolvers: (() => void)[] = []
    const choose = async (mode: string) => {
      const ticket = latest.begin()
      await new Promise<void>((r) => resolvers.push(r))
      if (latest.isLatest(ticket)) applied.push(mode)
    }
    const runs = ['auto', 'flow', 'energetic', 'gentle'].map(choose)
    for (const k of [2, 3, 0, 1]) resolvers[k]() // answers arrive out of order
    await Promise.all(runs)
    assert.deepEqual(applied, ['gentle'])
    const remix = createLatest()
    const t1 = remix.begin(), t2 = remix.begin(), t3 = remix.begin()
    assert.deepEqual([remix.isLatest(t1), remix.isLatest(t2), remix.isLatest(t3)], [false, false, true])
  })
})
