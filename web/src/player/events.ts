import type { Track } from '../api/library'

// Listening events on their way to POST /api/events. Events wait in a small
// buffer (kept in localStorage, so a closed tab or a dropped Wi-Fi connection
// loses nothing) and go out in batches. A failed batch is retried later with
// the same event ids, which the server stores only once.

export type ListeningEventType = 'play_started' | 'play_completed' | 'skip' | 'pause' | 'resume' | 'seek'

export interface TrackSnapshot {
  id: string
  title: string
  artist: string
  artist_id: string | null
  album: string | null
  album_id: string | null
  genres: string[]
  year: number | null
  duration_seconds: number | null
  cover_art_id: string | null
}

export interface ListeningEvent {
  event_id: string
  type: ListeningEventType
  track: TrackSnapshot
  play_id: string
  occurred_at: string
  position_s: number | null
  duration_s: number | null
  source: string
  mode: string | null
  radio_session_id: string | null
  radio_selection_id: number | null
  details: Record<string, unknown>
}

export const snapshot = (t: Track): TrackSnapshot => ({
  id: t.id,
  title: t.title,
  artist: t.artist,
  artist_id: t.artist_id,
  album: t.album,
  album_id: t.album_id,
  genres: t.genres,
  year: t.year,
  duration_seconds: t.duration_seconds,
  cover_art_id: t.cover_art_id,
})

export interface Reporter {
  report(event: ListeningEvent): void
  flush(): Promise<void>
  subscribe(listener: (event: ListeningEvent) => void): () => void
  pending(): number
}

export interface ReporterDeps {
  send: (events: ListeningEvent[]) => Promise<unknown>
  storage?: { load(): string | null; save(value: string): void }
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  delayMs?: number
}

const MAX_BUFFER = 300 // beyond this the oldest events are dropped
const BATCH = 100
const URGENT: ListeningEventType[] = ['skip', 'play_completed'] // radio steering waits on these
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 120_000

export function createReporter({
  send,
  storage,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  delayMs = 4_000,
}: ReporterDeps): Reporter {
  let buffer: ListeningEvent[] = restore()
  let sending: Promise<void> | null = null
  let timer: unknown = null
  let retryMs = 0
  const listeners = new Set<(event: ListeningEvent) => void>()

  function restore(): ListeningEvent[] {
    try {
      const saved = storage?.load()
      return saved ? (JSON.parse(saved) as ListeningEvent[]) : []
    } catch {
      return []
    }
  }

  const persist = () => {
    try {
      storage?.save(JSON.stringify(buffer))
    } catch {
      // Storage full or disabled: events still go out from memory.
    }
  }

  const schedule = (ms: number) => {
    if (timer !== null) clearTimer(timer)
    timer = setTimer(() => {
      timer = null
      void flush()
    }, ms)
  }

  async function flush(): Promise<void> {
    if (sending) return sending
    if (buffer.length === 0) return
    const batch = buffer.slice(0, BATCH)
    sending = (async () => {
      try {
        await send(batch)
        const sent = new Set(batch.map((e) => e.event_id))
        buffer = buffer.filter((e) => !sent.has(e.event_id))
        persist()
        retryMs = 0
        if (buffer.length) schedule(0)
      } catch {
        retryMs = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, retryMs * 2))
        schedule(retryMs)
      } finally {
        sending = null
      }
    })()
    return sending
  }

  if (buffer.length) schedule(delayMs) // events left over from last time

  return {
    report(event) {
      buffer = [...buffer, event].slice(-MAX_BUFFER)
      persist()
      for (const listener of listeners) listener(event)
      if (retryMs === 0) schedule(URGENT.includes(event.type) ? 300 : delayMs)
    },
    flush,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    pending: () => buffer.length,
  }
}
