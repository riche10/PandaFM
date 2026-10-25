import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MARQUEE_MIN_SECONDS, marqueeState } from './marquee.ts'

describe('marquee', () => {
  it('text that fits stays still', () => {
    assert.deepEqual(marqueeState(300, 180, false), { overflow: false, animate: false, shift: 0, duration: 0 })
    assert.equal(marqueeState(300, 301, false).overflow, false) // a pixel of rounding isn't overflow
    assert.equal(marqueeState(0, 500, false).overflow, false) // not laid out yet
  })

  it('overflowing text glides by exactly the hidden part, slower for longer text', () => {
    const short = marqueeState(300, 360, false)
    const long = marqueeState(300, 900, false)
    assert.deepEqual([short.overflow, short.animate, short.shift], [true, true, 60])
    assert.equal(short.duration, MARQUEE_MIN_SECONDS) // never frantic
    assert.equal(long.shift, 600)
    assert.ok(long.duration > short.duration)
    assert.ok(600 / (long.duration * 0.35) <= 45) // moving speed stays readable (~40 px/s)
  })

  it('a resize or rotation can switch it on and off', () => {
    assert.equal(marqueeState(320, 500, false).animate, true)
    assert.equal(marqueeState(640, 500, false).animate, false) // landscape: it fits now
  })

  it('reduced motion: still marked as overflowing (ellipsis), never animated', () => {
    assert.deepEqual([marqueeState(300, 900, true).overflow, marqueeState(300, 900, true).animate], [true, false])
  })
})
