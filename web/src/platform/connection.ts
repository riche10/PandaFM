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
  | 'interrupted' // 5.5.1: this session reached PandaFM; it isn't answering right now (the app stays up)

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
  /** 5.5.1: this session already had a usable connection to this same server address */
  everUsable?: boolean
}

export function deriveConnection(f: ConnectionFacts): ConnectionState {
  if (f.native && !f.hasServer) return 'no-server'
  if (f.offlineChosen && f.probe !== 'pandafm') return 'offline'
  if (f.probe === 'pending') return 'checking'
  // A network outage is not a lost configuration. And once this session has used this server, one failed
  // probe (a phone waking up, a busy API) must not tear the app down: 'interrupted' keeps it mounted.
  if (f.probe !== 'pandafm') return f.everUsable ? 'interrupted' : 'server-unreachable'
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
  return next === 'checking' && isUsableState(current) ? current : next
}

/** States in which the whole app (Now Playing, the queue, navigation) stays mounted, with at most a banner. */
export function isUsableState(s: ConnectionState): boolean {
  return s === 'ready' || s === 'degraded' || s === 'offline' || s === 'interrupted'
}

/** 5.5.1: the banner while PandaFM isn't answering: quiet after one miss, explicit after more. */
export function interruptedMessage(failures: number): string {
  return failures <= 1
    ? 'Reconnecting to PandaFM…'
    : 'PandaFM server is temporarily unreachable. Playback may continue from buffer or downloads.'
}

/** 5.5.1: automatic re-checks while interrupted (then every minute); "Try again" checks at once. */
export const RETRY_AFTER_MS = [5_000, 15_000, 30_000, 60_000]
