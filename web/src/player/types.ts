import type { Track } from '../api/library'

// The contract between the player store and whatever makes sound.
//
// The store only talks to a PlaybackEngine, never to <audio> directly, so the
// engine can grow (two decks, Web Audio crossfades for Panda DJ) without
// touching the store or any React component.

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export type PlaybackErrorKind = 'network' | 'decode' | 'unsupported' | 'missing' | 'unknown'

export type EngineEvent =
  | { type: 'loading' }
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'time'; position: number; duration: number | null }
  | { type: 'ended' }
  /** message: the engine's own readable explanation; explain: false when asking the server can't help (e.g. a local file). */
  | { type: 'error'; kind: PlaybackErrorKind; message?: string; explain?: boolean }

export interface PlaybackEngine {
  /**
   * Point the engine at a new source. Does not start playback. `track` lets a
   * native engine show title, artist and artwork on the lock screen.
   */
  load(src: string, track?: Track): void
  play(): Promise<void>
  pause(): void
  seek(seconds: number): void
  /** Release the current source entirely. */
  stop(): void
  /** Master volume, 0–1, applied to every deck. */
  setVolume(volume: number): void
  subscribe(listener: (event: EngineEvent) => void): () => void
}
