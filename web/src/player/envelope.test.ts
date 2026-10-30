import assert from 'node:assert/strict'
import { it, suite } from 'node:test'
import { envelope, scheduleTransition, type MixPlan } from './mixPlan.ts'

// 5.5: these reference values are computed once from the formula (in Python) and pinned in BOTH this test
// and Android's PandaDjEngineTest, so the browser, the preview and the phone play the same envelope.
const REFERENCE: [number, MixPlan['curve'], number, number, number, number][] = [
  [0.2, 'sharp', 0, 0, 0.997898, 0.064806],
  [0.5, 'equal_power', 0, -7, 0.707107, 0.472591],
  [0.5, 'equal_power', -6, 0, 0.500593, 0.707107],
  [0.3, 'under_tail', -4, -4, 0.792577, 0.065199],
  [0.75, 'linear', -3, -5, 0.192948, 0.649473],
  [0.9, 'sharp', -2, -8, 0.014614, 0.911863],
  [0.0, 'under_tail', 0, 0, 1, 0],
  [0.25, 'under_tail', 0, 0, 0.9375, 0.0625],
  [0.5, 'under_tail', 0, 0, 0.75, 0.25],
  [0.75, 'under_tail', 0, 0, 0.4375, 0.5625],
  [1.0, 'under_tail', 0, 0, 0, 1],
  [0.6, 'under_tail', -3, -6, 0.520212, 0.273088],
]

suite('5.5 transition envelope', () => {
  it('under_tail has headroom: the two gains never add up to more than full scale', () => {
    for (const [o, i] of [[0, 0], [-4, -4], [-8, 0], [0, -8]]) {
      for (let k = 0; k <= 200; k++) {
        const [out, inn] = envelope(k / 200, 'under_tail', o, i)
        assert.ok(out + inn <= 1 + 1e-9, `p=${k / 200}: ${out} + ${inn}`)
      }
    }
    for (let k = 0; k <= 100; k++) assert.ok(envelope(k / 200, 'under_tail')[0] >= 0.75 - 1e-9) // the held note rings out (first half ≥ 75%)
    assert.deepEqual(envelope(1, 'under_tail'), [0, 1]) // and B ends at its own level
  })

  it('matches the shared reference values (Android parity)', () => {
    for (const [p, curve, outDb, inDb, out, inn] of REFERENCE) {
      const [o, i] = envelope(p, curve, outDb, inDb)
      assert.ok(Math.abs(o - out) < 1e-5 && Math.abs(i - inn) < 1e-5, `${curve} @${p}: ${o}, ${i}`)
    }
  })

  it('never exceeds unity, and B always ends at its own level', () => {
    for (const curve of ['equal_power', 'linear', 'sharp', 'under_tail'] as const) {
      for (let k = 0; k <= 20; k++) {
        const [o, i] = envelope(k / 20, curve, -7, -7)
        assert.ok(o >= 0 && o <= 1 && i >= 0 && i <= 1)
      }
      assert.ok(Math.abs(envelope(1, curve, -7, -7)[1] - 1) < 1e-6, curve)
    }
  })

  it('schedules gains, the bass handoff and the high-pass exactly as planned', () => {
    const calls: string[] = []
    const param = (name: string) => ({ setValueCurveAtTime: (v: Float32Array, t: number, d: number) => calls.push(`${name} ${v.length} ${t} ${d} ${v[0].toFixed(3)}→${v[v.length - 1].toFixed(3)}`) })
    const deck = (n: string) => ({ gain: { gain: param(`${n}.gain`) }, shelf: { gain: param(`${n}.shelf`) }, hp: { frequency: param(`${n}.hp`) } })
    scheduleTransition(deck('A'), deck('B'), { curve: 'equal_power', filter: 'bass_swap', gain_out_db: 0, gain_in_db: -6 }, 10, 8)
    assert.deepEqual(calls, ['A.gain 64 10 8 1.000→0.000', 'B.gain 64 10 8 0.000→1.000', 'A.shelf 64 10 8 0.000→-24.000', 'B.shelf 64 10 8 -24.000→0.000'])
    calls.length = 0
    scheduleTransition(deck('A'), deck('B'), { curve: 'under_tail', filter: 'highpass_out' }, 0, 4)
    assert.deepEqual(calls.map((c) => c.split(' ')[0]), ['A.gain', 'B.gain', 'A.hp'])
    assert.ok(calls[0].endsWith('1.000→0.000') && calls[1].endsWith('0.000→1.000')) // A rings out as B takes over
  })
})
