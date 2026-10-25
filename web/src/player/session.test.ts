import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSnapshot, snapshotOf } from './session.ts'
import { resolveQuality, withQuality, loadQuality } from './streamQuality.ts'

const item = (i: number) => ({ uid: `u${i}`, track: { id: `t${i}`, title: `Song ${i}` } }) as never

describe('playback session snapshot', () => {
  it('keeps the queue, current song, source, shuffle, repeat, radio reference and position', () => {
    const source = { kind: 'radio' as const, name: 'Rock Radio', radio: { sessionId: 'abc', modeLabel: 'Rock Radio' } } as never
    const snap = snapshotOf({ items: [item(1), item(2), item(3)], index: 1, source, shuffle: true, repeat: 'all', position: 42.7 }, 1000)!
    assert.deepEqual([snap.index, snap.items.length, snap.shuffle, snap.repeat, snap.position, (snap.source as { radio: { sessionId: string } }).radio.sessionId],
      [1, 3, true, 'all', 42, 'abc'])
    assert.deepEqual(parseSnapshot(JSON.stringify(snap)), snap)
  })

  it('caps very long queues around the current song', () => {
    const items = Array.from({ length: 2000 }, (_, i) => item(i))
    const snap = snapshotOf({ items, index: 1500, source: null, shuffle: false, repeat: 'off', position: 0 })!
    assert.equal(snap.items.length, 500)
    assert.equal((snap.items[snap.index].track as { id: string }).id, 't1500')
  })

  it('ignores anything broken and empty queues', () => {
    assert.equal(snapshotOf({ items: [], index: -1, source: null, shuffle: false, repeat: 'off', position: 0 }), null)
    for (const raw of [null, '', '{', '{"v":2}', JSON.stringify({ v: 1, items: [item(1)], index: 3 }), JSON.stringify({ v: 1, items: [{}], index: 0 })]) {
      assert.equal(parseSnapshot(raw), null, String(raw))
    }
  })
})

describe('streaming quality', () => {
  const wifi = { metered: false, wifi: true }
  const cell = { metered: true, wifi: false }
  it('Auto: Original on Wi-Fi, High on mobile data (app); Original in browsers', () => {
    assert.equal(resolveQuality('auto', true, wifi), 'original')
    assert.equal(resolveQuality('auto', true, cell), 'high')
    assert.equal(resolveQuality('auto', false, cell), 'original')
    assert.equal(resolveQuality('auto', true, null), 'original')
  })
  it('a browser that can’t decode AAC always gets original files', () => {
    assert.equal(resolveQuality('low', false, null, false), 'original')
    assert.equal(resolveQuality('high', false, null, true), 'high')
  })
  it('a chosen quality wins over the network', () => {
    assert.equal(resolveQuality('low', true, wifi), 'low')
    assert.equal(resolveQuality('original', true, cell), 'original')
  })
  it('only the quality goes into the URL, never credentials', () => {
    assert.equal(withQuality('/api/tracks/a/stream', 'original'), '/api/tracks/a/stream')
    assert.equal(withQuality('/api/tracks/a/stream', 'high'), '/api/tracks/a/stream?quality=high')
    assert.equal(loadQuality({ getItem: () => 'nonsense' }), 'auto')
    assert.equal(loadQuality({ getItem: () => 'low' }), 'low')
  })
})
