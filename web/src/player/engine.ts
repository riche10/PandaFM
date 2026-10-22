import { Deck, type DeckId } from './deck'
import type { EngineEvent, PlaybackEngine } from './types'

/**
 * Owns the audio decks and exposes simple transport controls.
 *
 * Only the active deck's events reach listeners, so a future preloading or
 * crossfading deck can work in the background without confusing the
 * player store. Planned Panda DJ additions live here: preload(src) into the
 * standby deck, and a crossfade that swaps `active` (likely via Web Audio
 * gain nodes, which same-origin /api audio already permits).
 */
export class AudioEngine implements PlaybackEngine {
  private readonly decks: Record<DeckId, Deck>
  private active: DeckId = 'A'
  private readonly listeners = new Set<(event: EngineEvent) => void>()

  constructor(createElement: () => HTMLAudioElement = () => new Audio()) {
    this.decks = { A: new Deck('A', createElement()), B: new Deck('B', createElement()) }
    for (const deck of Object.values(this.decks)) {
      deck.listen((event) => {
        if (deck.id === this.active) this.emit(event)
      })
    }
  }

  private get deck(): Deck {
    return this.decks[this.active]
  }

  load(src: string): void {
    this.deck.load(src)
  }

  play(): Promise<void> {
    return this.deck.element.play()
  }

  pause(): void {
    this.deck.element.pause()
  }

  seek(seconds: number): void {
    const el = this.deck.element
    const end = Number.isFinite(el.duration) ? el.duration : Number.POSITIVE_INFINITY
    el.currentTime = Math.min(Math.max(0, seconds), end)
  }

  stop(): void {
    this.deck.unload()
  }

  setVolume(volume: number): void {
    // Master volume for every deck; a future crossfade scales within it.
    for (const deck of Object.values(this.decks)) deck.element.volume = volume
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
