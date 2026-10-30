import assert from 'node:assert/strict'
import { it, suite } from 'node:test'
import { inMixOrder, mixEntries } from './mixOrder.ts'
import { removalPlan } from './playlistRemoval.ts'

// 5.5.2: removing songs from a playlist while it shows its Panda Mix order.
const t = (id: string) => ({ id, title: id }) as never
const playlist = ['A', 'B', 'A', 'C'].map(t)

suite('5.5.2 playlist removal from the Panda Mix order', () => {
  it('each mixed row knows its own playlist position (duplicates are separate occurrences)', () => {
    const e = mixEntries(playlist, ['A', 'C', 'A', 'B'])
    assert.deepEqual(e.map((x) => x.index), [0, 3, 2, 1]) // the 1st A shown is the playlist's 1st A
    assert.deepEqual(inMixOrder(playlist, ['A', 'C', 'A', 'B']).map((x) => (x as { id: string }).id), ['A', 'C', 'A', 'B'])
    assert.deepEqual(mixEntries(playlist, undefined).map((x) => x.index), [0, 1, 2, 3])
  })

  it('original order: positions highest first, no mixed position', () => {
    assert.deepEqual(removalPlan([0, 2], ['A', 'B', 'A', 'C']), [{ index: 2, trackId: 'A' }, { index: 0, trackId: 'A' }])
  })

  it('mixed order: each row removes its own playlist position and its mixed position, adjusted as earlier ones go', () => {
    const indexes = mixEntries(playlist, ['A', 'C', 'A', 'B']).map((x) => x.index) // [0, 3, 2, 1]
    const ids = ['A', 'C', 'A', 'B']
    assert.deepEqual(removalPlan([0, 2], ids, indexes, true), [{ index: 2, trackId: 'A', mixIndex: 2 }, { index: 0, trackId: 'A', mixIndex: 0 }])
    assert.deepEqual(removalPlan([1, 3], ids, indexes, true), [{ index: 3, trackId: 'C', mixIndex: 1 }, { index: 1, trackId: 'B', mixIndex: 2 }]) // 3 → 2 after row 1 went
  })
})
