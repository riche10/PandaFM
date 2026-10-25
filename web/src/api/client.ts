// Thin fetch wrapper used by every API module. In a browser, paths stay
// relative (/api/...): PandaFM is served by its own server, directly or behind
// a reverse proxy. In the Android app, the same paths go to the configured
// server. apiUrl() is the only place that decides.

import { platform } from '../platform/state.ts'
import { authFetch } from './auth.ts'

export const apiUrl = (path: string) => `${platform.server}/api${path}`

export class ApiError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, message: string, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

/** Turn a failed response into an ApiError with a message people can read. */
export async function readApiError(response: Response): Promise<ApiError> {
  // PandaFM's own errors look like {"error": {"code": "...", "message": "..."}}.
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } }
    if (body.error?.message) {
      return new ApiError(response.status, body.error.message, body.error.code ?? null)
    }
  } catch {
    // Not JSON: usually the web container's Nginx answering for a stopped API.
  }
  if (response.status >= 502 && response.status <= 504) {
    return new ApiError(response.status, 'PandaFM’s API isn’t answering. It may be restarting.')
  }
  return new ApiError(response.status, `PandaFM’s server answered ${response.status}.`)
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await authFetch(apiUrl(path), { signal, headers: { Accept: 'application/json' } })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError(0, 'The PandaFM server could not be reached.')
  }
  if (!response.ok) throw await readApiError(response)
  return (await response.json()) as T
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  return new ApiError(0, err instanceof Error ? err.message : 'Something went wrong.')
}

/** POST / PUT / PATCH / DELETE with an optional JSON body. Returns parsed JSON, or null for 204. */
export async function apiSend<T = null>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response
  try {
    response = await authFetch(apiUrl(path), {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'The PandaFM server could not be reached.')
  }
  if (!response.ok) throw await readApiError(response)
  return (response.status === 204 ? null : await response.json()) as T
}
