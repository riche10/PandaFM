// Thin fetch wrapper used by every API module. Paths are relative (/api/...),
// so the app never needs to know the server's host name.

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api${path}`, { signal, headers: { Accept: 'application/json' } })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new ApiError(0, 'The PandaFM server could not be reached.')
  }
  if (!response.ok) {
    throw new ApiError(response.status, `The PandaFM API answered ${response.status} ${response.statusText}.`)
  }
  return (await response.json()) as T
}
