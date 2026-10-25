import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { isNative, platform } from '../platform/state.ts'
import { type AuthState, authHeaders, onUnauthorized } from './authCore.ts'

// Sign-in for PandaFM 5.0.
// Browser: an HttpOnly session cookie (never readable here) plus a CSRF
// header on writes. Android app: the native PandaAuth plugin signs in, keeps
// the refresh token encrypted with the Android Keystore and hands out
// short-lived access tokens, sent as 'Authorization: Bearer'. Tokens never go
// into URLs or localStorage.

export interface AuthStatus {
  setup_required: boolean
  signed_in: boolean
  username: string | null
  https: boolean
}

interface AuthStoreState {
  state: AuthState
  username: string | null
  https: boolean
}

export const authStore = createStore<AuthStoreState>()(() => ({ state: 'unknown', username: null, https: false }))
export const useAuth = () => useStore(authStore)

let accessToken: string | null = null

async function bearer(forceRefresh = false): Promise<string | null> {
  if (!platform.auth) return null
  if (!accessToken || forceRefresh) accessToken = (await platform.auth.accessToken({ forceRefresh }).catch(() => ({ token: null }))).token
  return accessToken
}

const base = () => `${platform.server}/api`
const cookie = () => (typeof document === 'undefined' ? '' : document.cookie)

async function codeOf(response: Response): Promise<string | null> {
  try {
    return ((await response.clone().json()) as { error?: { code?: string } }).error?.code ?? null
  } catch {
    return null
  }
}

/** fetch() for PandaFM's API: proves who we are, refreshes once, and sends the app to sign-in if the session ended. */
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const send = async (force = false) =>
    fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders(init.method, cookie(), await bearer(force)) } })
  let response = await send()
  if (response.status !== 401 || !url.startsWith(base())) return response
  let next = onUnauthorized(await codeOf(response))
  if (next === 'refresh' && platform.auth) {
    response = await send(true)
    if (response.status !== 401) return response
    next = onUnauthorized(await codeOf(response)) === 'refresh' ? 'signed-out' : onUnauthorized(await codeOf(response))
  }
  if (next !== 'refresh') authStore.setState({ state: next })
  return response
}

async function serverStatus(): Promise<AuthStatus> {
  const response = await fetch(`${base()}/auth/status`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`status ${response.status}`)
  return (await response.json()) as AuthStatus
}

/** On start: does this server need setup, and are we signed in? */
export async function checkAuth(): Promise<void> {
  try {
    const status = await serverStatus()
    let signedIn = status.signed_in
    if (platform.auth && !status.setup_required) signedIn = (await platform.auth.status()).signedIn && (await bearer(true)) !== null
    authStore.setState({ state: status.setup_required ? 'setup' : signedIn ? 'signed-in' : 'signed-out', username: status.username, https: status.https })
  } catch {
    // The server can't be reached. The app can still play downloads if this device was signed in.
    const known = platform.auth ? (await platform.auth.status().catch(() => ({ signedIn: false }))).signedIn : false
    authStore.setState({ state: known ? 'offline' : 'unreachable' })
  }
}

const deviceName = () => (isNative() ? '' : '') // the native side names Android devices (Build.MODEL); browsers are named by the server

async function readError(response: Response): Promise<string> {
  try {
    return ((await response.json()) as { error?: { message?: string } }).error?.message ?? `The server answered ${response.status}.`
  } catch {
    return `The server answered ${response.status}.`
  }
}

export async function signIn(username: string, password: string): Promise<void> {
  if (platform.auth) {
    const r = await platform.auth.signIn({ server: platform.server, username, password, deviceName: deviceName() })
    accessToken = null
    authStore.setState({ state: 'signed-in', username: r.username })
    return
  }
  const response = await fetch(`${base()}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, client: 'browser' }),
  })
  if (!response.ok) throw new Error(await readError(response))
  authStore.setState({ state: 'signed-in', username: ((await response.json()) as { username: string }).username })
}

export async function setupOwner(setupToken: string, username: string, password: string): Promise<void> {
  if (platform.auth) {
    const r = await platform.auth.setup({ server: platform.server, setupToken, username, password, deviceName: deviceName() })
    accessToken = null
    authStore.setState({ state: 'signed-in', username: r.username })
    return
  }
  const response = await fetch(`${base()}/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setup_token: setupToken, username, password, client: 'browser' }),
  })
  if (!response.ok) throw new Error(await readError(response))
  authStore.setState({ state: 'signed-in', username: ((await response.json()) as { username: string }).username })
}

/** Sign this device out. Downloaded music stays on the device. */
export async function signOut(): Promise<void> {
  if (platform.auth) await platform.auth.signOut().catch(() => undefined)
  else await authFetch(`${base()}/auth/logout`, { method: 'POST' }).catch(() => undefined)
  accessToken = null
  authStore.setState({ state: 'signed-out' })
}
