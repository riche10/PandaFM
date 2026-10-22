import type { RadioApi, RadioSessionOut } from '../player/radio'
import { apiGet, apiSend } from './client'
import type { Track } from './library'

export interface RadioMode {
  id: string
  label: string
  description: string
}

export const listRadioModes = (signal?: AbortSignal) => apiGet<RadioMode[]>('/radio/modes', signal)

export const radioApi: RadioApi = {
  start: (mode, seed) => apiSend('POST', '/radio/sessions', { mode, seed, count: 10 }),
  extend: (sessionId, upcoming, target) =>
    apiSend('POST', `/radio/sessions/${encodeURIComponent(sessionId)}/extend`, { upcoming, target }),
  end: (sessionId) => apiSend<RadioSessionOut>('POST', `/radio/sessions/${encodeURIComponent(sessionId)}/end`),
}

export interface HomeSections {
  recently_played: Track[]
  back_in_rotation: Track[]
  rediscover: Track[]
}

export const getHomeSections = (signal?: AbortSignal) => apiGet<HomeSections>('/me/home', signal)

export interface ListeningStats {
  events: number
  plays: number
  completion_rate: number | null
  skip_rate: number | null
  early_skip_rate: number | null
  tracks_cached: number
  tracks_available: number
  radio_sessions: number
  top_completed_artists: { name: string; completed: number; skips: number; early: number; plays: number }[]
  most_skipped_artists: { name: string; completed: number; skips: number; early: number; plays: number }[]
  top_genres: { name: string; minutes: number; completed: number }[]
  recent_sessions: { mode: string; status: string; seed: string | null; created_at: string; played: number; skipped: number; replaced: number; chosen: number }[]
}

export const getStats = (signal?: AbortSignal) => apiGet<ListeningStats>('/stats', signal)

export interface SyncStatus {
  running: boolean
  tracks_total: number
  tracks_available: number
  last_run: { status: string; started_at: string; finished_at: string | null; tracks_seen: number; tracks_added: number; tracks_missing: number; error: string | null } | null
}

export const getSyncStatus = (signal?: AbortSignal) => apiGet<SyncStatus>('/library/sync', signal)
export const startSync = () => apiSend<SyncStatus>('POST', '/library/sync')
