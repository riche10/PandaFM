import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import * as Q from './queue.ts'
import type { RadioController } from './radio.ts'
import { currentTrack, type PlayerStore } from './store.ts'

// Autoplay: when a finite queue (a song, an album, a playlist…) naturally
// runs out, carry on with Panda Radio seeded from what you were playing.
// It feeds the same shared queue through the same radio controller and the
// same Stage 3 engine. This module is its single owner: the store only says
// "the queue ended", once, after the last song was recorded as completed.

export interface AutoplaySettings {
  enabled: boolean
  preset: string // a built-in mode id or a custom preset id
}

const KEY = 'pandafm.autoplay'
export const DEFAULT_AUTOPLAY: AutoplaySettings = { enabled: true, preset: 'panda' }

function load(): AutoplaySettings {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}')
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_AUTOPLAY.enabled,
      preset: typeof raw.preset === 'string' && /^[a-z0-9-]{1,64}$/i.test(raw.preset) ? raw.preset : DEFAULT_AUTOPLAY.preset,
    }
  } catch {
    return DEFAULT_AUTOPLAY
  }
}

/** Per device: Autoplay may be on for the Walkman and off for the phone. */
export const autoplaySettings = createStore<AutoplaySettings>()(() => load())
autoplaySettings.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s))
  } catch {
    // this session only
  }
})
export const useAutoplaySettings = () => useStore(autoplaySettings)

export type Seed = { kind: 'track' | 'album' | 'artist'; id: string }

/** What the radio grows from: the album or artist you played, else the song that just finished. */
export function seedFor(state: Pick<Q.QueueState, 'items' | 'index' | 'source'>): Seed | null {
  const source = state.source
  if (source?.kind === 'album' && source.id) return { kind: 'album', id: source.id }
  if (source?.kind === 'artist' && source.id) return { kind: 'artist', id: source.id }
  const last = currentTrack(state)
  return last ? { kind: 'track', id: last.id } : null
}

export interface Autoplay {
  /** The queue ran out. Returns whether radio took over. */
  onQueueEnd(): Promise<boolean>
  /** The listener ended radio: don't restart it for this queue. */
  suppress(): void
}

export function createAutoplay({
  store,
  radio,
  settings = () => autoplaySettings.getState(),
  online = () => true,
  notify = () => undefined,
}: {
  store: PlayerStore
  radio: Pick<RadioController, 'continueWith'>
  settings?: () => AutoplaySettings
  online?: () => boolean
  notify?: (message: string, tone?: 'info' | 'error') => void
}): Autoplay {
  let inFlight = false
  let handled: string | null = null // the queue item whose ending we already handled
  let suppressedQueue: string | null = null // first item of the queue in which radio was ended

  return {
    suppress() {
      const s = store.getState()
      suppressedQueue = s.items[0]?.uid ?? null
    },

    async onQueueEnd() {
      const s = store.getState()
      const item = s.items[s.index]
      if (!item || inFlight || handled === item.uid) return false // one handoff per ending, whoever calls
      handled = item.uid
      const why =
        !settings().enabled ? 'disabled'
        : s.status !== 'ended' ? 'not-ended'
        : s.repeat !== 'off' ? 'repeat'
        : Q.nextIndex(s) !== null ? 'more-queued'
        : s.source?.kind === 'radio' ? 'radio-active'
        : suppressedQueue !== null && suppressedQueue === s.items[0]?.uid ? 'radio-ended-by-you'
        : !online() ? 'offline'
        : null
      if (why) return false
      const seed = seedFor(s)
      inFlight = true
      try {
        const took = await radio.continueWith(settings().preset, seed, item.uid)
        if (took) {
          const info = store.getState().source?.radio
          notify(`${info?.modeLabel ?? 'Panda Radio'}${info?.seedName ? ` · Based on ${info.seedName}` : ''}`)
        }
        return took
      } catch {
        notify('Couldn’t continue with Panda Radio', 'error') // once; the finished queue stays as it was
        return false
      } finally {
        inFlight = false
      }
    },
  }
}
