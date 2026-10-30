import { Deck, type DeckId } from './deck.ts'
import { type MixPlan, scheduleTransition, timeline } from './mixPlan.ts'
import type { EngineEvent, PlaybackEngine } from './types'

/** The bits of Web Audio Panda Mix uses (an interface, so tests can provide a fake). */
interface Param {
  value: number
  setValueAtTime(v: number, t: number): unknown
  setValueCurveAtTime(values: Float32Array, t: number, duration: number): unknown
  cancelScheduledValues(t: number): unknown
}
interface Node {
  connect(n: unknown): unknown
}
interface Ctx {
  currentTime: number
  destination: unknown
  state: string
  createGain(): Node & { gain: Param }
  createBiquadFilter(): Node & { type: string; frequency: Param; gain: Param }
  createMediaElementSource(el: HTMLAudioElement): Node
  suspend(): Promise<void>
  resume(): Promise<void>
}
type Chain = { gain: Node & { gain: Param }; shelf: Node & { type: string; frequency: Param; gain: Param }; hp: Node & { type: string; frequency: Param; gain: Param } }

const TICK_MS = 50
const WARM_AFTER_MS = 2000 // let the current song settle before opening the next one
const MIN_OVERLAP_S = 1.5 // a late incoming deck still gets a blend while at least this much of it is left

/**
 * Owns the audio decks and exposes simple transport controls.
 *
 * Only the active deck's events reach listeners. Normal playback uses deck A
 * alone, exactly as before. Panda Mix (5.2): the next song preloads into the
 * standby deck, and at the plan's start both decks play through Web Audio
 * gain (and filter) nodes, automated on the audio clock; at the midpoint the
 * standby becomes active (the store adopts the next song), and at the end the
 * old deck unloads. Web Audio is only switched on the first time a Panda Mix
 * plays. Browsers throttle timers in background tabs, so a transition can start
 * up to a second late there; the automation itself stays precise.
 */
export class AudioEngine implements PlaybackEngine {
  private readonly decks: Record<DeckId, Deck>
  private active: DeckId = 'A'
  private readonly listeners = new Set<(event: EngineEvent) => void>()
  private ctx: Ctx | null = null
  private chains: Partial<Record<DeckId, Chain>> = {}
  private master: (Node & { gain: Param }) | null = null
  private volume = 1
  private pending: { src: string; plan: MixPlan; onHandoff: () => boolean } | null = null
  private preloaded = false
  private running = false
  private handedOff = false
  private beganAt = 0
  private watch: ReturnType<typeof setInterval> | null = null
  private timers: ReturnType<typeof setTimeout>[] = []
  private warm: { src: string; timer: ReturnType<typeof setTimeout> | null; loaded: boolean } | null = null

  private readonly createContext: () => Ctx | null

  constructor(
    createElement: () => HTMLAudioElement = () => new Audio(),
    createContext: () => Ctx | null = () => (typeof AudioContext === 'undefined' ? null : (new AudioContext() as unknown as Ctx)),
  ) {
    this.createContext = createContext
    this.decks = { A: new Deck('A', createElement()), B: new Deck('B', createElement()) }
    for (const deck of Object.values(this.decks)) {
      deck.listen((event) => {
        if (deck.id === this.active) this.emit(event)
        else if (event.type === 'error' && (this.preloaded || this.running) && !this.handedOff) this.cancelTransition() // B failed: A plays on
      })
    }
  }

  private get deck(): Deck {
    return this.decks[this.active]
  }

  private get standby(): Deck {
    return this.decks[this.active === 'A' ? 'B' : 'A']
  }

  load(src: string): void {
    // 5.4: exactly the warmed next song: promote the standby deck instead of reloading it
    const w = this.warm
    if (w?.loaded && w.src === src && !this.running && !this.pending && this.standby.element.readyState >= 2) {
      const old = this.deck
      this.active = this.standby.id
      this.warm = null
      old.unload()
      const ctx = this.ctx
      if (ctx) for (const id of ['A', 'B'] as DeckId[]) this.neutral(id, id === this.active ? 1 : 0, ctx.currentTime)
      return
    }
    this.dropWarm()
    this.cancelTransition()
    this.deck.load(src)
  }

  /** 5.4: ordinary playback warms the next song on the standby deck (silently; the browser buffers it). */
  warmNext(src: string | null): void {
    if (!src || this.running || this.pending) {
      this.dropWarm() // nothing next, or a Panda Mix owns the standby deck
      return
    }
    if (this.warm?.src === src) return
    this.dropWarm()
    const w: NonNullable<AudioEngine['warm']> = { src, timer: null, loaded: false }
    this.warm = w
    w.timer = setTimeout(() => {
      if (this.warm !== w || this.pending || this.running) return
      this.standby.load(src)
      w.loaded = true
    }, WARM_AFTER_MS)
  }

  private dropWarm(): void {
    const w = this.warm
    if (!w) return
    if (w.timer) clearTimeout(w.timer)
    if (w.loaded && !this.running && !this.preloaded) this.standby.unload()
    this.warm = null
  }

  /** Diagnostics: the warmed next song, if any. */
  warmState() {
    return this.warm ? { src: this.warm.src, loaded: this.warm.loaded, ready: this.warm.loaded && this.standby.element.readyState >= 2 } : null
  }

  play(): Promise<void> {
    if (this.running) {
      void this.ctx?.resume()
      void this.standby.element.play().catch(() => undefined)
    }
    return this.deck.element.play()
  }

  pause(): void {
    this.deck.element.pause()
    if (this.running) {
      this.standby.element.pause()
      void this.ctx?.suspend() // the automation waits with the music
    }
  }

  seek(seconds: number): void {
    // Cancel a blend in progress cleanly, but keep the pair: it re-arms from the new position (5.2 forgot it).
    const keep = this.handedOff ? null : this.pending
    this.cancelTransition()
    if (keep) {
      this.pending = keep
      if (this.watch === null) this.watch = setInterval(() => this.tick(), TICK_MS)
    }
    const el = this.deck.element
    const end = Number.isFinite(el.duration) ? el.duration : Number.POSITIVE_INFINITY
    el.currentTime = Math.min(Math.max(0, seconds), end)
  }

  stop(): void {
    this.cancelTransition()
    this.deck.unload()
  }

  setVolume(volume: number): void {
    this.volume = volume
    if (this.master) this.master.gain.value = volume
    else for (const deck of Object.values(this.decks)) deck.element.volume = volume
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  // ── Panda Mix ──
  prepareNext(src: string | null, plan: MixPlan | null, onHandoff: () => boolean): void {
    if (this.running) return
    if (src && plan) this.dropWarm() // the mix preload takes over the standby deck // the current blend finishes first; the store re-plans after the handoff
    if (!src || !plan) {
      this.dropPending()
      return
    }
    if (this.pending && (this.pending.src !== src || this.pending.plan.to !== plan.to)) this.dropPending()
    if (!this.ensureGraph()) return // no Web Audio: songs simply play one after another
    this.pending = { src, plan, onHandoff }
    if (this.watch === null) this.watch = setInterval(() => this.tick(), TICK_MS)
  }

  inTransitionBeforeHandoff(): boolean {
    return this.running && !this.handedOff
  }

  completeTransitionNow(): void {
    if (!this.running) return
    if (!this.handedOff) this.handoff()
    this.finish()
  }

  private ensureGraph(): boolean {
    if (this.ctx) return true
    const ctx = this.createContext()
    if (!ctx) return false
    this.ctx = ctx
    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(ctx.destination)
    for (const deck of Object.values(this.decks)) {
      deck.element.volume = 1 // the master gain carries the volume from now on
      const shelf = ctx.createBiquadFilter()
      shelf.type = 'lowshelf'
      shelf.frequency.value = 200
      shelf.gain.value = 0
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 10
      const gain = ctx.createGain()
      gain.gain.value = deck.id === this.active ? 1 : 0
      ctx.createMediaElementSource(deck.element).connect(shelf)
      shelf.connect(hp)
      hp.connect(gain)
      gain.connect(this.master)
      this.chains[deck.id] = { gain, shelf, hp }
    }
    return true
  }

  /** Runs every 50 ms while a transition is pending (the audio itself is scheduled on the audio clock). */
  tick(): void {
    const p = this.pending
    if (!p || this.running) return
    const t = timeline(p.plan)
    const now = this.deck.element.currentTime
    if (this.deck.element.paused) return
    if (!this.preloaded && now >= t.preloadAt) {
      this.preloaded = true
      const el = this.standby.element
      this.chains[this.standby.id]!.gain.gain.value = 0
      const at = p.plan.incoming_start_ms / 1000
      const seekIn = () => {
        el.removeEventListener('loadedmetadata', seekIn)
        el.currentTime = at
      }
      el.addEventListener('loadedmetadata', seekIn)
      this.standby.load(p.src)
    }
    const latest = t.startAt + Math.max(0, t.overlap - MIN_OVERLAP_S)
    if (!this.preloaded && now > latest && t.overlap > MIN_OVERLAP_S) {
      this.dropPending() // e.g. a seek past the transition: this song ends normally
      return
    }
    if (this.preloaded && now >= t.startAt) {
      if (this.standby.element.readyState >= 3) this.begin(p, Math.max(0, now - t.startAt))
      else if (now > latest) this.cancelTransition() // B never got ready: A plays to its end
    }
  }

  private begin(p: NonNullable<AudioEngine['pending']>, late = 0): void {
    const ctx = this.ctx!
    const planned = timeline(p.plan)
    const t = { ...planned, overlap: Math.max(0, planned.overlap - late) } // late: the same ending, a shorter blend
    this.running = true
    this.handedOff = false
    this.beganAt = ctx.currentTime
    const outChain = this.chains[this.active]!
    const inChain = this.chains[this.standby.id]!
    const when = ctx.currentTime
    const span = Math.max(0.01, t.overlap)
    for (const param of [outChain.gain.gain, inChain.gain.gain]) param.cancelScheduledValues(when)
    scheduleTransition(outChain, inChain, p.plan, when, span) // the same envelope the Adjust Mix preview plays
    void this.standby.element.play().catch(() => this.cancelTransition())
    const half = Math.max(0, (t.overlap / 2) * 1000)
    this.timers.push(setTimeout(() => this.handoff(), half))
    this.timers.push(setTimeout(() => this.finish(), Math.max(half, t.overlap * 1000)))
  }

  private handoff(): void {
    if (!this.running || this.handedOff || !this.pending) return
    this.handedOff = true
    if (!this.pending.onHandoff()) { // the queue moved on: keep the current song
      this.handedOff = false
      this.cancelTransition()
      return
    }
    this.active = this.standby.id
    const el = this.deck.element
    this.emit({ type: 'playing' })
    this.emit({ type: 'time', position: el.currentTime, duration: Number.isFinite(el.duration) ? el.duration : null })
  }

  private finish(): void {
    if (!this.running) return
    const ctx = this.ctx!
    this.standby.unload() // the outgoing deck (standby now) lets go of its source
    for (const id of ['A', 'B'] as DeckId[]) this.neutral(id, id === this.active ? 1 : 0, ctx.currentTime)
    this.clearTimers()
    this.running = false
    this.preloaded = false
    this.handedOff = false
    this.pending = null
    this.stopWatch()
  }

  /** Drop a pending or running transition: the active deck plays alone at full volume. Never touches a later song. */
  cancelTransition(): void {
    const ctx = this.ctx
    this.clearTimers()
    if (this.running || this.preloaded) this.standby.unload()
    if (ctx) for (const id of ['A', 'B'] as DeckId[]) this.neutral(id, id === this.active ? 1 : 0, ctx.currentTime)
    this.running = false
    this.preloaded = false
    this.handedOff = false
    this.pending = null
    this.stopWatch()
    if (ctx && ctx.state === 'suspended') void ctx.resume()
  }

  private neutral(id: DeckId, gain: number, t: number) {
    const c = this.chains[id]
    if (!c) return
    for (const param of [c.gain.gain, c.shelf.gain, c.hp.frequency]) param.cancelScheduledValues(t)
    c.gain.gain.setValueAtTime(gain, t)
    c.shelf.gain.setValueAtTime(0, t)
    c.hp.frequency.setValueAtTime(10, t)
  }

  private dropPending() {
    if (this.preloaded && !this.running) this.standby.unload()
    this.preloaded = false
    this.pending = null
    this.stopWatch()
  }

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  /** The 50 ms watch runs only while a transition is pending: never idle, never after it. */
  private stopWatch() {
    if (this.watch !== null) {
      clearInterval(this.watch)
      this.watch = null
    }
  }

  /** Diagnostics: which deck is current and what the mix is doing. */
  mixState() {
    return { active: this.active, running: this.running, preloaded: this.preloaded, handedOff: this.handedOff, plan: this.pending?.plan ?? null, since: this.beganAt }
  }
}
