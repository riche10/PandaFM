// Per-device playback session (5.0): restored after a restart, paused, never auto-playing.
import type { QueueItem, QueueSource, RepeatMode } from './queue'

export interface SessionSnapshot {
  v: 1
  items: QueueItem[]
  index: number
  source: QueueSource | null
  shuffle: boolean
  repeat: RepeatMode
  position: number
  savedAt: number
}

export const SESSION_KEY = 'pandafm.session'
const MAX_ITEMS = 500

/** A compact snapshot: at most 500 songs around the current one. */
export function snapshotOf(state: { items: QueueItem[]; index: number; source: QueueSource | null; shuffle: boolean; repeat: RepeatMode; position: number }, now = Date.now()): SessionSnapshot | null {
  if (state.index < 0 || state.items.length === 0) return null
  const from = Math.max(0, Math.min(state.index - 100, state.items.length - MAX_ITEMS))
  const items = state.items.slice(from, from + MAX_ITEMS)
  return { v: 1, items, index: state.index - from, source: state.source, shuffle: state.shuffle, repeat: state.repeat, position: Math.max(0, Math.floor(state.position)), savedAt: now }
}

/** Read a saved snapshot defensively: anything odd means "nothing to restore". */
export function parseSnapshot(raw: string | null): SessionSnapshot | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as SessionSnapshot
    if (s?.v !== 1 || !Array.isArray(s.items) || s.items.length === 0) return null
    if (!Number.isInteger(s.index) || s.index < 0 || s.index >= s.items.length) return null
    if (!s.items.every((i) => i && typeof i.uid === 'string' && i.track && typeof i.track.id === 'string')) return null
    const repeat: RepeatMode = s.repeat === 'all' || s.repeat === 'one' ? s.repeat : 'off'
    return { ...s, repeat, shuffle: !!s.shuffle, position: Number.isFinite(s.position) && s.position > 0 ? s.position : 0 }
  } catch {
    return null
  }
}
