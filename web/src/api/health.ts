import { apiGet } from './client'

// Mirrors HealthResponse in api/app/routers/health.py.
export interface DatabaseStatus {
  ok: boolean
  detail: string | null
  server_version: string | null
}

export interface NavidromeStatus {
  ok: boolean
  detail: string | null
  server_type: string | null
  server_version: string | null
  open_subsonic: boolean | null
}

export interface Health {
  status: 'ok' | 'degraded'
  version: string
  database: DatabaseStatus
  navidrome: NavidromeStatus
}

export const fetchHealth = (signal?: AbortSignal) => apiGet<Health>('/health', signal)
