// One explicit model of "can this app use its PandaFM server right now?" (5.3).
// Pure: the facts are gathered elsewhere (api/connection.ts), so every
// distinction is unit-tested. The Android app and browsers use the same states.

export type ConnectionState =
  | 'checking'
  | 'no-server' // Android: no PandaFM address saved yet
  | 'server-unreachable' // the PandaFM server didn't answer (or isn't PandaFM)
  | 'setup-required' // reachable, but no owner yet
  | 'sign-in-required' // reachable, set up, this device isn't signed in
  | 'music-server-required' // signed in, but no music server connected yet
  | 'ready'
  | 'offline' // the user chose to continue with downloads
  | 'degraded' // PandaFM works, but its music server doesn't answer

export type Probe = 'pending' | 'pandafm' | 'unreachable' | 'not-pandafm'

export interface ConnectionFacts {
  native: boolean
  hasServer: boolean
  probe: Probe
  ownerConfigured?: boolean
  signedIn?: boolean
  musicServerConfigured?: boolean
  musicServerOk?: boolean
  offlineChosen?: boolean
}

export function deriveConnection(f: ConnectionFacts): ConnectionState {
  if (f.native && !f.hasServer) return 'no-server'
  if (f.offlineChosen && f.probe !== 'pandafm') return 'offline'
  if (f.probe === 'pending') return 'checking'
  if (f.probe !== 'pandafm') return 'server-unreachable' // a network outage is not a lost configuration
  if (f.ownerConfigured === false) return 'setup-required'
  if (f.signedIn === undefined || f.ownerConfigured === undefined) return 'checking'
  if (!f.signedIn) return 'sign-in-required'
  if (f.musicServerConfigured === false) return 'music-server-required'
  if (f.musicServerOk === false) return 'degraded' // PandaFM is fine; its music server isn't (not an address problem)
  return 'ready'
}

/** Did we reach PandaFM, rather than some other web server? */
export function isPandaHealth(body: unknown): body is { service?: string; version: string; status: string; database: { ok: boolean }; navidrome: { ok: boolean; configured?: boolean; url?: string | null } } {
  if (!body || typeof body !== 'object') return false
  const b = body as Record<string, unknown>
  if (b.service !== undefined && b.service !== 'pandafm') return false
  return typeof b.version === 'string' && typeof b.status === 'string' && typeof b.database === 'object' && b.database !== null && typeof b.navidrome === 'object' && b.navidrome !== null
}

/** What to show for a saved server: its host (and port), never credentials or paths. */
export function displayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * 5.4.1: a re-check (back online, after sign-in) while PandaFM is already usable keeps the current
 * screen until the result is in. 5.3 went back to 'checking' every time, which unmounted the whole
 * app (Now Playing included) on every network reconnect, for up to the probe's timeout.
 */
export function whileRechecking(current: ConnectionState, next: ConnectionState): ConnectionState {
  const usable = current === 'ready' || current === 'degraded' || current === 'offline'
  return next === 'checking' && usable ? current : next
}
