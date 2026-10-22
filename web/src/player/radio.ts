import type { Track } from '../api/library'
import type { Reporter } from './events'
import * as Q from './queue.ts'
import type { PlayerStore } from './store'

// Panda Radio's client side: it feeds radio picks into the SAME shared queue.
// While a session is active it keeps a few radio songs queued ahead, asks the
// server to re-plan right after a radio song is skipped, and never stops the
// music when the server can't be reached; it simply tries again later.

export interface RadioPickOut {
  selection_id: number
  track: Track
  reasons: string[]
  score: number
  breakdown: Record<string, number>
}

export interface RadioSessionOut {
  id: string
  mode: string
  mode_label: string
  status: string
  seed_kind: string | null
  seed_name: string | null
  skips: number
  completions: number
  exploration: number
}

export interface RadioApi {
  start(mode: string, seed: { kind: 'track' | 'album' | 'artist'; id: string } | null): Promise<{ session: RadioSessionOut; seed_track: Track | null; picks: RadioPickOut[] }>
  extend(sessionId: string, upcoming: number[], target: number): Promise<{ session: RadioSessionOut; replaced: number[]; picks: RadioPickOut[] }>
  end(sessionId: string): Promise<unknown>
}

export interface RadioController {
  start(mode: string, seed: { kind: 'track' | 'album' | 'artist'; id: string } | null, options?: { keepCurrent?: boolean }): Promise<void>
  end(): Promise<void>
  /** Top up (or, with steer, re-plan) the radio songs queued ahead. */
  refill(steer?: boolean): Promise<void>
}

export const REFILL_BELOW = 5 // fetch more when fewer radio songs than this are queued ahead
export const TARGET_AHEAD = 8
const RETRY_AFTER_MS = 15_000

export function createRadioController({
  api,
  store,
  reporter,
  now = Date.now,
  setTimer = (fn: () => void, ms: number) => setTimeout(fn, ms),
}: {
  api: RadioApi
  store: PlayerStore
  reporter: Pick<Reporter, 'flush' | 'subscribe'>
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
}): RadioController {
  let busy = false
  let steerAgain = false
  let retryAt = 0

  const active = () => {
    const source = store.getState().source
    return source?.kind === 'radio' ? source.radio : undefined
  }

  const toPicks = (picks: RadioPickOut[], sessionId: string): Q.RadioPickInput[] =>
    picks.map((p) => ({ track: p.track, radio: { sessionId, selectionId: p.selection_id, reasons: p.reasons } }))

  async function refill(steer = false): Promise<void> {
    const radio = active()
    if (!radio) return
    if (busy) {
      if (steer) steerAgain = true // run once more when the current request finishes
      return
    }
    const ahead = Q.radioUpcoming(store.getState(), radio.sessionId)
    if (!steer && (ahead.length >= REFILL_BELOW || now() < retryAt)) return
    busy = true
    try {
      const out = await api.extend(radio.sessionId, ahead.map((item) => item.radio!.selectionId), TARGET_AHEAD)
      if (active()?.sessionId !== radio.sessionId) return // radio ended meanwhile
      store.getState().addRadio(out.replaced, toPicks(out.picks, radio.sessionId))
      retryAt = 0
    } catch {
      // Server unreachable: keep playing what's queued and try again later.
      retryAt = now() + RETRY_AFTER_MS
      setTimer(() => void refill(), RETRY_AFTER_MS)
    } finally {
      busy = false
      if (steerAgain) {
        steerAgain = false
        void refill(true)
      }
    }
  }

  // Keep the buffer topped up as songs play.
  store.subscribe(() => void refill())

  // A skipped radio song changes the session's direction: deliver the skip,
  // then ask for a re-plan of the radio songs still queued.
  reporter.subscribe((event) => {
    const radio = active()
    if (event.type === 'skip' && radio && event.radio_session_id === radio.sessionId) {
      void reporter.flush().then(() => refill(true))
    }
  })

  return {
    async start(mode, seed, { keepCurrent = false } = {}) {
      const out = await api.start(mode, seed)
      const radio: Q.RadioInfo = {
        sessionId: out.session.id,
        mode: out.session.mode,
        modeLabel: out.session.mode_label,
        seedName: out.session.seed_name,
      }
      retryAt = 0
      store.getState().startRadio(
        toPicks(out.picks, radio.sessionId),
        { kind: 'radio', id: radio.sessionId, name: radio.modeLabel, radio },
        { seedTrack: keepCurrent ? null : out.seed_track, keepCurrent },
      )
    },
    async end() {
      const radio = active()
      if (!radio) return
      store.getState().endRadio() // stop growing now; the music carries on
      try {
        await api.end(radio.sessionId)
      } catch {
        // The server ends idle sessions on the next start anyway.
      }
    },
    refill,
  }
}
