import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { all, descending, empty, extend, pick, toggle } from './selection.ts'

describe('multi-select', () => {
  it('toggles rows and keeps list order', () => {
    let s = toggle(empty, 3)
    s = toggle(s, 1)
    assert.deepEqual(pick(s, ['a', 'b', 'c', 'd']), ['b', 'd'])
    assert.deepEqual(pick(toggle(s, 3), ['a', 'b', 'c', 'd']), ['b'])
  })

  it('Shift-click selects the range from the anchor, either way', () => {
    assert.deepEqual([...extend(toggle(empty, 1), 4).picked].sort(), [1, 2, 3, 4])
    assert.deepEqual([...extend(toggle(empty, 4), 2).picked].sort(), [2, 3, 4])
    assert.deepEqual([...extend(empty, 2).picked], [2]) // no anchor yet: just this row
  })

  it('a song listed twice can be selected once or twice (positions, not ids)', () => {
    const items = ['x', 'y', 'x']
    assert.deepEqual(pick(toggle(empty, 2), items), ['x'])
    assert.deepEqual(pick(all(3), items), ['x', 'y', 'x'])
  })

  it('removal order is highest position first, so the rest stay valid', () => {
    assert.deepEqual(descending(toggle(toggle(toggle(empty, 1), 7), 4)), [7, 4, 1])
  })

  it('ignores positions past the end (the list changed)', () => {
    assert.deepEqual(pick(toggle(empty, 9), ['a']), [])
  })
})
