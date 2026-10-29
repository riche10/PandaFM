import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { AudioEngine } from './engine.ts'
import { bassCurves, fallbackPlan, gainCurves, type MixPlan, MixPlanner, timeline } from './mixPlan.ts'
import { createPlayerStore } from './store.ts'

// Node has no MediaError; the decks read its codes when a source fails.
;(globalThis as Record<string, unknown>).MediaError ??= { MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 }

const track = (id: string, duration = 200) => ({ id, title: id, artist: 'X', duration_seconds: duration }) as never

describe('Panda Mix plans', () => {
  it('the fallback is a short, safe equal-power blend', () => {
    const p = fallbackPlan(track('a'), track('b'), 'auto')
    assert.deepEqual([p.outgoing_start_ms, p.overlap_ms, p.curve, p.ready, p.source], [192000, 5000, 'equal_power', false, 'fallback']) // ends 3 s before the end
    assert.equal(fallbackPlan(track('a'), track('b'), 'gentle').overlap_ms, 3500)
  })

  it('the handoff is the midpoint', () => {
    const t = timeline({ outgoing_start_ms: 190000, overlap_ms: 10000 } as MixPlan)
    assert.deepEqual(t, { preloadAt: 170, startAt: 190, handoffAt: 195, endAt: 200, overlap: 10 })
  })

  it('equal power has no dip; bass handoff swaps the lows at the midpoint', () => {
    const c = gainCurves('equal_power', 65)
    assert.ok(Math.abs(c.out[32] ** 2 + c.in[32] ** 2 - 1) < 1e-6)
    assert.equal(c.out[0], 1)
    assert.ok(c.in[64] > 0.9999)
    const b = bassCurves(65)
    assert.equal(b.out[32], -24)
    assert.equal(b.in[32], -24)
    assert.equal(b.in[64], 0)
  })

  it('plans are cached by directional pair and fetched at most every 20 s', async () => {
    let now = 0
    const asked: unknown[] = []
    const planner = new MixPlanner(async (body) => {
      asked.push(body)
      return { transitions: [{ ...fallbackPlan(track('a'), track('b'), 'auto'), ready: true, type: 'deep_blend', summary: 'Deep Blend · 24 sec' }] }
    }, () => now)
    let updated = 0
    const first = planner.plan(track('a'), track('b'), 'auto', 'p1', [track('a'), track('b')], () => updated++)
    assert.equal(first.type, 'smooth_blend') // the fallback, at once
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(updated, 1)
    assert.equal(planner.plan(track('a'), track('b'), 'auto', 'p1', [track('a'), track('b')], () => undefined).type, 'deep_blend')
    assert.equal(planner.plan(track('b'), track('a'), 'auto', 'p1', [track('b'), track('a')], () => undefined).type, 'smooth_blend') // B→A isn't A→B
    now = 5000
    planner.plan(track('b'), track('a'), 'auto', 'p1', [track('b'), track('a')], () => undefined)
    assert.equal(asked.length, 2)
  })
})

// ── the web dual deck, with fake <audio> and AudioContext ──
class FakeParam {
  value = 0
  log: string[] = []
  setValueAtTime(v: number) { this.value = v; this.log.push(`set ${v}`) }
  setValueCurveAtTime(values: Float32Array) { this.log.push(`curve ${values[0].toFixed(2)}→${values[values.length - 1].toFixed(2)}`) }
  cancelScheduledValues() { this.log.push('cancel') }
}
const node = () => ({ connect() {} })
class FakeCtx {
  currentTime = 0
  destination = {}
  state = 'running'
  createGain() { return { ...node(), gain: new FakeParam() } }
  createBiquadFilter() { return { ...node(), type: '', frequency: new FakeParam(), gain: new FakeParam() } }
  createMediaElementSource() { return node() }
  async suspend() { this.state = 'suspended' }
  async resume() { this.state = 'running' }
}
class FakeAudio {
  src = ''
  currentTime = 0
  duration = 200
  paused = true
  readyState = 0
  volume = 1
  preload = ''
  ended = false
  error = null
  private handlers: Record<string, (() => void)[]> = {}
  loads = 0
  load() { this.loads++; this.readyState = 1; this.fire('loadedmetadata') }
  play() { this.paused = false; this.fire('playing'); return Promise.resolve() }
  pause() { this.paused = true; this.fire('pause') }
  removeAttribute() { this.src = '' }
  getAttribute() { return this.src || null }
  addEventListener(n: string, h: () => void) { (this.handlers[n] ??= []).push(h) }
  removeEventListener(n: string, h: () => void) { this.handlers[n] = (this.handlers[n] ?? []).filter((x) => x !== h) }
  fire(n: string) { for (const h of [...(this.handlers[n] ?? [])]) h() }
}

function mixRig() {
  const els: FakeAudio[] = []
  const ctx = new FakeCtx()
  const engine = new AudioEngine(() => { const a = new FakeAudio(); els.push(a); return a as unknown as HTMLAudioElement }, () => ctx as never)
  const plan: MixPlan = { from: 'a', to: 'b', type: 'smooth_blend', summary: '', outgoing_start_ms: 190000, incoming_start_ms: 2000, overlap_ms: 10000, curve: 'equal_power', confidence: 0.8, ready: true, filter: null }
  return { els, ctx, engine, plan }
}

describe('web dual deck (Panda Mix)', () => {
  it('preloads, blends, hands off at the midpoint and unloads the old deck', async () => {
    const { els: [a, b], engine, plan } = mixRig()
    engine.load('/a')
    await engine.play()
    let handoffs = 0
    engine.prepareNext('/b', plan, () => { handoffs++; return true })
    a.currentTime = 160
    engine.tick()
    assert.equal(b.src, '') // too early (the lead is 20 s)
    a.currentTime = 178.5
    engine.tick()
    assert.equal(b.src, '/b')
    assert.equal(b.currentTime, 2) // at its planned start
    b.readyState = 4
    a.currentTime = 190
    engine.tick()
    assert.equal(engine.inTransitionBeforeHandoff(), true)
    assert.equal(b.paused, false)
    engine.completeTransitionNow() // (the midpoint and end timers, run now)
    assert.equal(handoffs, 1)
    assert.equal(engine.mixState().active, 'B')
    assert.equal(a.src, '') // the outgoing deck let go of its source
    assert.equal(engine.inTransitionBeforeHandoff(), false)
  })

  it('pause freezes the blend on the audio clock; a seek cancels it', async () => {
    const { els: [a, b], ctx, engine, plan } = mixRig()
    engine.load('/a')
    await engine.play()
    engine.prepareNext('/b', plan, () => true)
    a.currentTime = 178.5
    engine.tick()
    b.readyState = 4
    a.currentTime = 190
    engine.tick()
    engine.pause()
    assert.equal(ctx.state, 'suspended')
    assert.ok(a.paused && b.paused)
    await engine.play()
    assert.equal(ctx.state, 'running')
    engine.seek(60)
    assert.equal(engine.inTransitionBeforeHandoff(), false)
    assert.equal(b.src, '')
    assert.equal(a.currentTime, 60)
    engine.stop() // the pair stays armed after a seek; a test cleans up like the player does
  })

  it('a failed incoming deck drops the blend and A plays on', async () => {
    const { els: [a, b], engine, plan } = mixRig()
    engine.load('/a')
    await engine.play()
    engine.prepareNext('/b', plan, () => true)
    a.currentTime = 178.5
    engine.tick()
    b.fire('error')
    assert.equal(engine.mixState().preloaded, false)
    assert.equal(a.paused, false)
    a.currentTime = 190
    engine.tick()
    assert.equal(engine.inTransitionBeforeHandoff(), false) // no blend: A ends normally
  })

  it('a seek re-arms the pair; a late incoming deck still gets a shorter blend', async () => {
    const { els: [a, b], engine, plan } = mixRig()
    engine.load('/a')
    await engine.play()
    engine.prepareNext('/b', plan, () => true)
    a.currentTime = 178.5
    engine.tick()
    b.readyState = 4
    a.currentTime = 190
    engine.tick()
    engine.seek(60) // cancels the blend, keeps the pair
    assert.equal(engine.inTransitionBeforeHandoff(), false)
    a.currentTime = 178.5
    engine.tick()
    assert.equal(b.src, '/b') // prepared again
    b.readyState = 1 // not ready at the transition point
    a.currentTime = 190
    engine.tick()
    assert.equal(engine.inTransitionBeforeHandoff(), false)
    b.readyState = 4
    a.currentTime = 194
    engine.tick() // 4 s late: still a blend
    assert.equal(engine.inTransitionBeforeHandoff(), true)
    engine.completeTransitionNow()
  })

  it('normal playback never builds the Web Audio graph', async () => {
    let built = 0
    const engine = new AudioEngine(() => new FakeAudio() as unknown as HTMLAudioElement, () => { built++; return new FakeCtx() as never })
    engine.load('/a')
    await engine.play()
    engine.setVolume(0.5)
    engine.prepareNext(null, null, () => false)
    assert.equal(built, 0)
  })
})

describe('the store adopts the next song at the handoff', () => {
  it('A completes once, B starts once, without being reloaded', async () => {
    const reports: string[] = []
    const loads: string[] = []
    let handoff: (() => boolean) | null = null
    const engine = {
      load: (src: string) => loads.push(src), play: async () => undefined, pause() {}, seek() {}, stop() {}, setVolume() {},
      subscribe: (l: (e: never) => void) => { listener = l; return () => undefined },
      prepareNext: (_s: string | null, _p: unknown, h: () => boolean) => { handoff = h },
    }
    let listener: (e: never) => void = () => undefined
    const store = createPlayerStore({
      engine: engine as never, streamUrl: (id) => `/s/${id}`, explainError: async () => null as never,
      report: (r) => reports.push(`${r.type}:${r.item.track.id}`),
      mixPlanner: new MixPlanner(async () => ({ transitions: [] })),
    })
    store.getState().playCollection([track('a'), track('b'), track('c')], { source: { kind: 'playlist', name: 'Mix', id: 'p', mix: { mode: 'auto', playlistId: 'p' } } })
    listener({ type: 'playing' } as never)
    await new Promise((r) => setTimeout(r, 0))
    const adopt = handoff as unknown as (() => boolean) | null
    assert.ok(adopt, 'a transition was planned')
    assert.equal(adopt(), true)
    assert.equal(store.getState().index, 1)
    assert.deepEqual(reports, ['play_started:a', 'play_completed:a', 'play_started:b'])
    assert.deepEqual(loads, ['/s/a']) // B was never reloaded
  })
})

describe('5.4 browser next-track warmup', () => {
  it('warms the next song silently and promotes it on Next instead of reloading', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { els: [a, b], engine } = mixRig()
      engine.load('/a')
      await engine.play()
      engine.warmNext('/b')
      assert.equal(b.src, '') // the current song settles first
      mock.timers.tick(2000)
      assert.equal(b.src, '/b')
      assert.equal(b.paused, true) // warm, never audible
      b.readyState = 4
      engine.load('/b')
      assert.equal(engine.mixState().active, 'B')
      assert.equal(b.loads, 1) // not reloaded
      assert.equal(a.src, '') // the old deck let go
      engine.warmNext('/c')
      mock.timers.tick(2000)
      assert.equal(a.src, '/c') // the following song warms on the other deck
      engine.stop()
    } finally {
      mock.timers.reset()
    }
  })

  it('a changed next song or a different source falls back to a normal load', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const { els: [a, b], engine } = mixRig()
      engine.load('/a')
      await engine.play()
      engine.warmNext('/b')
      mock.timers.tick(2000)
      engine.warmNext('/x') // the queue changed: /b is no longer next
      assert.equal(b.src, '')
      mock.timers.tick(2000)
      assert.equal(b.src, '/x')
      b.readyState = 4
      engine.load('/x?quality=low') // a different source than the one warmed
      assert.equal(engine.mixState().active, 'A')
      assert.equal(a.src, '/x?quality=low')
      assert.equal(b.src, '')
    } finally {
      mock.timers.reset()
    }
  })
})
