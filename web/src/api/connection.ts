import { createStore, useStore } from 'zustand'
import { isNative, platform } from '../platform/state.ts'
import { type ConnectionState, deriveConnection, isPandaHealth, type Probe, RETRY_AFTER_MS, whileRechecking } from '../platform/connection.ts'
import { authStore, checkAuth } from './auth.ts'
import { apiUrl } from './client.ts'

export interface SetupState {
  owner_configured: boolean
  music_server_configured: boolean
  ready: boolean
  setup_token_required: boolean
}

interface ConnectionStore {
  state: ConnectionState
  probe: Probe
  setup: SetupState | null
  musicServerOk: boolean | null
  offlineChosen: boolean
  /** 5.5.1: this session has had a usable connection to `serverKey` */
  everUsable: boolean
  serverKey: string
  /** consecutive failed probes (0 after any success) */
  failures: number
  /** recent transitions, newest first, for Settings › Diagnostics */
  events: string[]
}

const initial = (): ConnectionStore => ({ state: 'checking', probe: 'pending', setup: null, musicServerOk: null, offlineChosen: false, everUsable: false, serverKey: '', failures: 0, events: [] })
export const connectionStore = createStore<ConnectionStore>()(() => {
  const start = { ...initial(), events: [`${new Date().toISOString().slice(11, 19)} app started`, ...loadEvents()].slice(0, 30) }
  return start
})
export const useConnection = <T,>(selector: (s: ConnectionStore) => T) => useStore(connectionStore, selector)

const PROBE_TIMEOUT_MS = 8000

async function fetchJson(path: string): Promise<unknown> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
  try {
    const r = await fetch(apiUrl(path), { headers: { Accept: 'application/json' }, signal: abort.signal, credentials: 'same-origin' })
    return await r.json()
  } finally {
    clearTimeout(timer)
  }
}

const serverKey = () => (isNative() ? platform.server : '') || ''
const EVENTS = 30
const EVENTS_KEY = 'pandafm.connection.events'

// 5.5.2: the log survives the app (WebView) restarting, so Diagnostics can show what happened just before.
function loadEvents(): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(EVENTS_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string').slice(0, EVENTS) : []
  } catch {
    return []
  }
}

function saveEvents(events: string[]) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(EVENTS_KEY, JSON.stringify(events.slice(0, EVENTS)))
  } catch {
    // storage full or unavailable: the in-memory log still works
  }
}

const stamp = () => new Date().toISOString().slice(11, 19)

/** 5.5.2: a line in the connection log (no addresses, tokens or credentials: callers pass plain facts). */
export function noteConnectionEvent(text: string): void {
  const events = [`${stamp()} ${text}`, ...connectionStore.getState().events].slice(0, EVENTS)
  connectionStore.setState({ events })
  saveEvents(events)
}

function update(trigger?: string) {
  const s = connectionStore.getState()
  const auth = authStore.getState().state
  const sameServer = s.serverKey === serverKey()
  const everUsable = s.everUsable && sameServer // a changed address starts over
  // Once usable, a failed auth *request* (offline, unreachable) is the network, not a sign-out: only the
  // server or the device's credential saying so signs this app out.
  const transientAuth = auth === 'offline' || auth === 'unreachable'
  const next = deriveConnection({
    native: isNative(),
    hasServer: !!platform.server || !isNative(),
    probe: s.probe,
    ownerConfigured: s.setup?.owner_configured,
    signedIn: everUsable && transientAuth ? true : auth === 'unknown' ? undefined : auth === 'signed-in',
    musicServerConfigured: s.setup?.music_server_configured,
    musicServerOk: s.musicServerOk ?? undefined,
    offlineChosen: s.offlineChosen,
    everUsable,
  })
  const state = whileRechecking(s.state, next)
  // usable *for this server*: only a state derived from a real answer counts, never one kept on screen
  // while a check (perhaps for a new address) is still pending
  const usableNow = s.probe === 'pandafm' && (next === 'ready' || next === 'degraded')
  const lines: string[] = []
  if (state !== s.state || trigger) lines.push(`${stamp()} ${trigger ?? 'update'}: ${s.state} → ${state} (probe ${s.probe}, failures ${s.failures})`)
  if (s.everUsable && !sameServer) lines.push(`${stamp()} server address changed: the new one must answer first`)
  if (!s.everUsable && usableNow) lines.push(`${stamp()} usable this session`)
  const events = lines.length ? [...lines.reverse(), ...s.events].slice(0, EVENTS) : s.events
  connectionStore.setState({ state, everUsable: everUsable || usableNow, serverKey: everUsable || usableNow ? serverKey() : s.serverKey, events })
  if (lines.length) saveEvents(events)
  if (!s.everUsable && usableNow && isNative()) void platform.player?.markSessionUsable?.({ server: serverKey() }).catch(() => undefined)
  scheduleRetry()
}

// Signing in (or creating the owner) changes what the server will tell us (e.g. owner now exists,
// music server still missing): fetch the facts again. checkConnection() reuses a run in progress.
authStore.subscribe((now, before) => {
  if (now.state === 'signed-in' && before.state !== 'signed-in') void checkConnection({ trigger: 'sign-in' })
  else update()
})

let running: Promise<void> | null = null
let generation = 0
let seeded = false

/**
 * 5.5.2: the UI can restart (a WebView or Activity recreated) while the app process, and the music, carry
 * on. If this process already reached this same server, the restarted UI is not a first launch: a failed
 * first check is 'interrupted' (the app, Now Playing and the queue stay), not the full unreachable screen.
 * The marker lives in the native process, so it is gone after a real cold start.
 */
async function seedFromNativeSession(): Promise<void> {
  if (seeded) return
  seeded = true
  const s = connectionStore.getState()
  if (s.everUsable || !isNative() || !platform.player?.getSession) return
  try {
    const session = await Promise.race([platform.player.getSession(), new Promise<null>((r) => setTimeout(() => r(null), 800))])
    if (session?.usableServer && session.usableServer === serverKey()) {
      connectionStore.setState({ everUsable: true, serverKey: serverKey() })
      noteConnectionEvent('app restarted under a live session: reconnecting, not a first launch')
    }
  } catch {
    // no native session to ask: a normal first launch
  }
}
let retryTimer: ReturnType<typeof setTimeout> | null = null

/** While interrupted, check again on a short schedule (5, 15, 30 s, then every minute) until it answers. */
function scheduleRetry() {
  const s = connectionStore.getState()
  if (s.state !== 'interrupted') {
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    return
  }
  if (retryTimer || running) return
  const ms = RETRY_AFTER_MS[Math.min(s.failures - 1, RETRY_AFTER_MS.length - 1)] ?? RETRY_AFTER_MS[0]
  retryTimer = setTimeout(() => {
    retryTimer = null
    void checkConnection({ trigger: 'retry' })
  }, ms)
}

/**
 * Gather the facts (launch, Try again, after sign-in or setup, back online) and derive the state.
 * Calls while a check runs share it, unless `fresh` (Try again, a settings change): then a new check
 * starts and the older one's result is discarded when it lands. A result is also discarded if the
 * server address changed meanwhile. A failure after this session has been usable doesn't tear the
 * app down ('interrupted'); see deriveConnection.
 */
export function checkConnection(opts: { fresh?: boolean; trigger?: string } = {}): Promise<void> {
  if (running && !opts.fresh) return running
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  const mine = ++generation
  const server = serverKey()
  const current = () => mine === generation && server === serverKey()
  const run = (async () => {
    await seedFromNativeSession()
    connectionStore.setState({ probe: 'pending', offlineChosen: false })
    update(opts.trigger ?? 'check')
    if (isNative() && !platform.server) return update()
    let probe: Probe = 'unreachable'
    let musicServerOk: boolean | null = null
    try {
      const health = await fetchJson('/health')
      probe = isPandaHealth(health) ? 'pandafm' : 'not-pandafm'
      if (isPandaHealth(health)) musicServerOk = health.navidrome.ok
    } catch {
      probe = 'unreachable'
    }
    if (!current()) return noteConnectionEvent('a stale check was discarded') // a newer check (or another server) owns the state now
    let setup: SetupState | null = connectionStore.getState().setup
    if (probe === 'pandafm') {
      setup = ((await fetchJson('/setup/state').catch(() => null)) as SetupState | null) ?? setup
      await checkAuth()
      if (!current()) return noteConnectionEvent('a stale check was discarded')
      connectionStore.setState({ probe, setup, musicServerOk, failures: 0 })
    } else {
      // keep the last known facts: only the probe and the failure count change
      connectionStore.setState({ probe, failures: connectionStore.getState().failures + 1 })
    }
    update(probe === 'pandafm' ? 'answered' : `probe ${probe}`)
  })().finally(() => {
    if (running === run) running = null
    scheduleRetry()
  })
  running = run
  return run
}

/** Test only: back to a fresh session. */
export function resetConnectionForTests(): void {
  generation++
  running = null
  seeded = false
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  connectionStore.setState(initial())
}

/** "Continue offline": play downloads without the server (the saved address is kept). */
export function continueOffline() {
  connectionStore.setState({ offlineChosen: true })
  update()
}
