// Pure pieces of authentication (no browser or API imports), unit-tested.

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const isUnsafe = (method: string | undefined) => UNSAFE.has((method ?? 'GET').toUpperCase())

/** The CSRF token the server put in the readable pandafm_csrf cookie. */
export function csrfFromCookie(cookie: string): string | null {
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === 'pandafm_csrf') return decodeURIComponent(rest.join('=')) || null
  }
  return null
}

/** Headers proving who we are: a Bearer token (Android) or, for browser writes, the CSRF token. */
export function authHeaders(method: string | undefined, cookie: string, bearer: string | null): Record<string, string> {
  if (bearer) return { Authorization: `Bearer ${bearer}` }
  const csrf = isUnsafe(method) ? csrfFromCookie(cookie) : null
  return csrf ? { 'X-PandaFM-CSRF': csrf } : {}
}

export type AuthState = 'unknown' | 'setup' | 'signed-out' | 'signed-in' | 'offline' | 'unreachable'

/** What a 401 means for the app: refresh the token and retry, or show sign-in / setup. */
export function onUnauthorized(code: string | null): 'refresh' | AuthState {
  if (code === 'token_expired') return 'refresh'
  if (code === 'setup_required') return 'setup'
  return 'signed-out'
}
