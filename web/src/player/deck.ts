import type { EngineEvent, PlaybackErrorKind } from './types'

export type DeckId = 'A' | 'B'

/**
 * One audio source. Stage 2 plays through deck A only; deck B exists so a
 * future Panda DJ engine can preload the next song and crossfade into it.
 */
export class Deck {
  readonly id: DeckId
  readonly element: HTMLAudioElement

  constructor(id: DeckId, element: HTMLAudioElement) {
    this.id = id
    this.element = element
    element.preload = 'auto'
  }

  load(src: string): void {
    this.element.src = src
    this.element.load()
  }

  unload(): void {
    this.element.pause()
    this.element.removeAttribute('src')
    this.element.load()
  }

  /** Translate this deck's DOM media events into engine events. */
  listen(emit: (event: EngineEvent) => void): void {
    const el = this.element
    const time = () =>
      emit({
        type: 'time',
        position: el.currentTime,
        duration: Number.isFinite(el.duration) ? el.duration : null,
      })

    el.addEventListener('loadstart', () => emit({ type: 'loading' }))
    el.addEventListener('waiting', () => emit({ type: 'loading' }))
    el.addEventListener('playing', () => emit({ type: 'playing' }))
    // A finished song also fires 'pause'; 'ended' reports that case.
    el.addEventListener('pause', () => el.ended || emit({ type: 'paused' }))
    el.addEventListener('timeupdate', time)
    el.addEventListener('durationchange', time)
    el.addEventListener('seeked', time)
    el.addEventListener('ended', () => emit({ type: 'ended' }))
    el.addEventListener('error', () => {
      // Ignore the error raised by unload() clearing the source.
      if (!el.getAttribute('src')) return
      emit({ type: 'error', kind: errorKind(el.error) })
    })
  }
}

function errorKind(error: MediaError | null): PlaybackErrorKind {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
      return 'network'
    case MediaError.MEDIA_ERR_DECODE:
      return 'decode'
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'unsupported'
    default:
      return 'unknown'
  }
}
