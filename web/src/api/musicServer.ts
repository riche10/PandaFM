import { apiGet, apiSend } from './client'

export interface MusicServerInfo {
  configured: boolean
  url: string | null
  username: string | null
  server_type?: string | null
  server_version?: string | null
  source?: string | null
  verified_at?: string | null
  problem?: string | null
  sync?: { running?: boolean; [key: string]: unknown }
}

export interface ConnectionTest {
  ok: boolean
  kind: 'ok' | 'bad_url' | 'unreachable' | 'bad_credentials' | 'not_subsonic'
  message: string
  url?: string | null
  server_type?: string | null
  server_version?: string | null
}

export const getMusicServer = () => apiGet<MusicServerInfo>('/music-server')
export const testMusicServer = (url: string, username: string, password: string) => apiSend<ConnectionTest>('POST', '/music-server/test', { url, username, password: password || null })
export const saveMusicServer = (url: string, username: string, password: string) => apiSend<MusicServerInfo>('PUT', '/music-server', { url, username, password: password || null })
export const resyncLibrary = () => apiSend('POST', '/library/sync')
