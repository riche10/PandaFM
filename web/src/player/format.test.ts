import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatLength, formatTime } from './format.ts'

describe('formatTime', () => {
  it('formats minutes and hours', () => {
    assert.equal(formatTime(7), '0:07')
    assert.equal(formatTime(245.9), '4:05')
    assert.equal(formatTime(3729), '1:02:09')
  })

  it('treats unknown values as zero', () => {
    assert.equal(formatTime(null), '0:00')
    assert.equal(formatTime(Number.NaN), '0:00')
    assert.equal(formatTime(-3), '0:00')
  })
})

describe('formatLength', () => {
  it('reads like a header', () => {
    assert.equal(formatLength(380), '6 min')
    assert.equal(formatLength(4330), '1 hr 12 min')
    assert.equal(formatLength(null), '')
  })
})
