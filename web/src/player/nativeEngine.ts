import type { Track } from '../api/library'
import type { NativePlayerEvent, NativeRemoteCommand, PandaPlayerPlugin } from '../platform/native'
import type { EngineEvent, PlaybackEngine, PlaybackErrorKind } from './types'

// Android's PlaybackEngine: Media3 / ExoPlayer in a MediaSessionService,
// reached through the PandaPlayer Capacitor plugin. Same contract as the
// browser's <audio> engine, so the store, queue, radio and Autoplay are
// untouched. The native side plays one song at a time; the shared queue
// decides what comes next.

export const NATIVE_ERROR_MESSAGES: Record<PlaybackErrorKind, string> = {
  network: 'Playback stopped because the connection was lost.',
  decode: 'This audio file could not be decoded.',
  unsupported: 'This audio format isn’t supported on this device.',
  missing: 'This downloaded file is missing.',
  unknown: 'This song couldn’t be played.',
}

const REASON_MESSAGES: Record<string, string> = {
  connect: 'The PandaFM server could not be reached.',
  timeout: 'The PandaFM server took too long to answer.',
  cleartext: 'This app build only allows https:// servers.',
  no_permission: 'PandaFM can no longer read your download folder. Choose it again in Settings.',
}

export function nativeErrorMessage(event: Pick<NativePlayerEvent, 'kind' | 'reason'>): string {
  return (event.reason && REASON_MESSAGES[event.reason]) || NATIVE_ERROR_MESSAGES[event.kind ?? 'unknown'] || NATIVE_ERROR_MESSAGES.unknown
}

export class NativePlaybackEngine implements PlaybackEngine {
  private listeners = new Set<(event: EngineEvent) => void>()
  private remoteListeners = new Set<(command: NativeRemoteCommand) => void>()
  private gen = 0
  private endedGen = -1
  private local = false
  private plugin: PandaPlayerPlugin
  private artworkFor: (track: Track) => string | null

  constructor(plugin: PandaPlayerPlugin, { artworkFor }: { artworkFor: (track: Track) => string | null }) {
    this.plugin = plugin
    this.artworkFor = artworkFor
    void plugin.addListener('state', (event) => this.handle(event))
    void plugin.addListener('remote', (command) => {
      for (const l of this.remoteListeners) l(command)
    })
  }

  /** System media controls (lock screen, notification, Bluetooth, headset). */
  onRemote(listener: (command: NativeRemoteCommand) => void): () => void {
    this.remoteListeners.add(listener)
    return () => this.remoteListeners.delete(listener)
  }

  load(src: string, track?: Track): void {
    this.gen++
    this.local = src.startsWith('content://')
    void this.plugin.load({
      gen: this.gen,
      url: src,
      trackId: track?.id ?? '',
      title: track?.title ?? '',
      artist: track?.artist ?? '',
      album: track?.album ?? null,
      artworkUrl: track ? this.artworkFor(track) : null,
      durationSeconds: track?.duration_seconds ?? null,
    }).catch(() => this.emit({ type: 'error', kind: 'unknown', message: 'PandaFM’s player didn’t start.', explain: false }))
  }

  play(): Promise<void> {
    return this.plugin.play({ gen: this.gen }).then(() => undefined)
  }

  pause(): void {
    void this.plugin.pause()
  }

  seek(seconds: number): void {
    void this.plugin.seek({ position: seconds })
  }

  stop(): void {
    this.gen++ // anything the old source still says is stale now
    void this.plugin.stop()
  }

  setVolume(volume: number): void {
    void this.plugin.setVolume({ volume })
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: EngineEvent) {
    for (const l of this.listeners) l(event)
  }

  /** Native events become the same EngineEvents <audio> produces. */
  private handle(event: NativePlayerEvent) {
    if (event.gen !== this.gen) return // from a previous song
    switch (event.type) {
      case 'loading':
      case 'playing':
      case 'paused':
        this.emit({ type: event.type })
        break
      case 'time':
        this.emit({ type: 'time', position: event.position ?? 0, duration: event.duration ?? null })
        break
      case 'ended':
        if (this.endedGen === event.gen) return // one completion per song, however often it's reported
        this.endedGen = event.gen
        this.emit({ type: 'ended' })
        break
      case 'error': {
        const kind = event.kind ?? 'unknown'
        // A local file's problem is local: asking the server (maybe offline) wouldn't explain it.
        this.emit({ type: 'error', kind, message: nativeErrorMessage(event), explain: !this.local && kind === 'network' ? true : false })
        break
      }
    }
  }
}
