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
  start: (preset, seed) => apiSend('POST', '/radio/sessions', { preset, seed, count: 10 }),
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

/** The six high-level controls a preset tunes (0-100); the server turns them into bounded weights. */
export interface RadioControls {
  familiarity: number
  discovery: number
  continuity: number
  artist_variety: number
  genre_variety: number
  wildcards: number
}

export interface RadioPreset {
  id: string // "study" for built-ins, a uuid for your own
  kind: 'builtin' | 'custom'
  name: string
  default_name: string | null
  base_mode: string
  base_name: string
  description: string
  controls: RadioControls
}

export const presetsApi = {
  list: (signal?: AbortSignal) => apiGet<RadioPreset[]>('/radio/presets', signal),
  create: (body: { name: string; base_mode: string; controls?: RadioControls }) => apiSend<RadioPreset>('POST', '/radio/presets', body),
  update: (id: string, body: { name?: string; base_mode?: string; controls?: RadioControls }) =>
    apiSend<RadioPreset>('PATCH', `/radio/presets/${encodeURIComponent(id)}`, body),
  remove: (id: string) => apiSend<null>('DELETE', `/radio/presets/${encodeURIComponent(id)}`),
  duplicate: (id: string) => apiSend<RadioPreset>('POST', `/radio/presets/${encodeURIComponent(id)}/duplicate`),
  rename: (mode: string, name: string | null) => apiSend<RadioPreset>('PATCH', `/radio/modes/${encodeURIComponent(mode)}`, { name }),
}

/** A saved station: WHAT music to stay near (genres), played with a radio style (preset). */
export interface RadioStation {
  id: string
  name: string
  genres: string[]
  families: string[]
  preset: string
  preset_name: string
  preset_missing: boolean
  label: string // "Rock" or "Rock · Familiar"
}

export interface LibraryGenre {
  name: string
  songs: number
  family: string | null
}

export const stationsApi = {
  list: () => apiGet<RadioStation[]>('/radio/stations'),
  genres: () => apiGet<LibraryGenre[]>('/radio/genres'),
  create: (body: { name: string; genres: string[]; preset: string | null }) => apiSend<RadioStation>('POST', '/radio/stations', body),
  update: (id: string, body: { name?: string; genres?: string[]; preset?: string | null }) => apiSend<RadioStation>('PATCH', `/radio/stations/${encodeURIComponent(id)}`, body),
  remove: (id: string) => apiSend<null>('DELETE', `/radio/stations/${encodeURIComponent(id)}`),
  duplicate: (id: string) => apiSend<RadioStation>('POST', `/radio/stations/${encodeURIComponent(id)}/duplicate`),
}
