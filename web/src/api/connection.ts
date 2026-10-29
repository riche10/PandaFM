import { createStore, useStore } from 'zustand'
import { isNative, platform } from '../platform/state'
import { type ConnectionState, deriveConnection, isPandaHealth, type Probe, whileRechecking } from '../platform/connection'
import { authStore, checkAuth } from './auth'
import { apiUrl } from './client'

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
}

export const connectionStore = createStore<ConnectionStore>()(() => ({ state: 'checking', probe: 'pending', setup: null, musicServerOk: null, offlineChosen: false }))
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

function update() {
  const s = connectionStore.getState()
  const auth = authStore.getState().state
  const next = deriveConnection({
      native: isNative(),
      hasServer: !!platform.server || !isNative(),
      probe: s.probe,
      ownerConfigured: s.setup?.owner_configured,
      signedIn: auth === 'unknown' ? undefined : auth === 'signed-in',
      musicServerConfigured: s.setup?.music_server_configured,
      musicServerOk: s.musicServerOk ?? undefined,
      offlineChosen: s.offlineChosen,
  })
  connectionStore.setState({ state: whileRechecking(s.state, next) })
}
// Signing in (or creating the owner) changes what the server will tell us (e.g. owner now exists,
// music server still missing): fetch the facts again. checkConnection() reuses a run in progress.
authStore.subscribe((now, before) => {
  if (now.state === 'signed-in' && before.state !== 'signed-in') void checkConnection()
  else update()
})

let running: Promise<void> | null = null

/** Gather the facts once (launch, Try again, after sign-in or setup, back online) and derive the state. */
export function checkConnection(): Promise<void> {
  running ??= (async () => {
    connectionStore.setState({ probe: 'pending', offlineChosen: false })
    update()
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
    let setup: SetupState | null = null
    if (probe === 'pandafm') {
      setup = (await fetchJson('/setup/state').catch(() => null)) as SetupState | null
      await checkAuth()
    }
    connectionStore.setState({ probe, setup, musicServerOk })
    update()
  })().finally(() => {
    running = null
  })
  return running
}

/** "Continue offline": play downloads without the server (the saved address is kept). */
export function continueOffline() {
  connectionStore.setState({ offlineChosen: true })
  update()
}
