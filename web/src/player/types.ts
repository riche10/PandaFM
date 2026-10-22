// The contract between the player store and whatever makes sound.
//
// The store only talks to a PlaybackEngine, never to <audio> directly, so the
// engine can grow (two decks, Web Audio crossfades for Panda DJ) without
// touching the store or any React component.

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export type PlaybackErrorKind = 'network' | 'decode' | 'unsupported' | 'unknown'

export type EngineEvent =
  | { type: 'loading' }
  | { type: 'playing' }
  | { type: 'paused' }
  | { type: 'time'; position: number; duration: number | null }
  | { type: 'ended' }
  | { type: 'error'; kind: PlaybackErrorKind }

export interface PlaybackEngine {
  /** Point the active deck at a new source. Does not start playback. */
  load(src: string): void
  play(): Promise<void>
  pause(): void
  seek(seconds: number): void
  /** Release the current source entirely. */
  stop(): void
  /** Master volume, 0–1, applied to every deck. */
  setVolume(volume: number): void
  subscribe(listener: (event: EngineEvent) => void): () => void
}
