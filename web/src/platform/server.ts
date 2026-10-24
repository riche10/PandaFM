import { platform } from './state.ts'

// The Android app's PandaFM server: entered once, remembered, changeable in Settings.

const SERVER_KEY = 'pandafm.server'

export interface ServerCheck {
  ok: boolean
  url: string
  steps: { label: string; ok: boolean; detail?: string }[]
  message?: string
}

/** "music.example.com/" -> "https://music.example.com"; rejects anything that isn't http(s). */
export function normalizeServerUrl(input: string): string {
  let text = input.trim()
  if (!text) throw new Error('Enter your PandaFM server’s address.')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('That doesn’t look like a web address.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Use an https:// (or http://) address.')
  if (url.username || url.password) throw new Error('Leave passwords out of the address.')
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api$/, '')
  return `${url.protocol}//${url.host}${path}`
}

export function savedServer(storage: Pick<Storage, 'getItem'> = localStorage): string {
  try {
    return storage.getItem(SERVER_KEY) ?? ''
  } catch {
    return ''
  }
}

export function saveServer(url: string, storage: Pick<Storage, 'setItem'> = localStorage): void {
  storage.setItem(SERVER_KEY, url)
  platform.server = url
}

/** Ask a server's /api/health whether it is PandaFM and whether its parts are up. */
export async function checkServer(input: string, fetcher: typeof fetch = fetch): Promise<ServerCheck> {
  let url: string
  try {
    url = normalizeServerUrl(input)
  } catch (err) {
    return { ok: false, url: input, steps: [], message: (err as Error).message }
  }
  const steps: ServerCheck['steps'] = []
  let body: { status?: string; version?: string; database?: { ok: boolean; detail?: string }; navidrome?: { ok: boolean; detail?: string } }
  try {
    const response = await fetcher(`${url}/api/health`, { headers: { Accept: 'application/json' } })
    body = await response.json()
    if (!response.ok || typeof body?.version !== 'string') throw new Error('not PandaFM')
  } catch (err) {
    const insecure = url.startsWith('http://')
    return {
      ok: false,
      url,
      steps: [{ label: 'PandaFM server found', ok: false }],
      message:
        (err as Error).message === 'not PandaFM'
          ? 'Something answered at that address, but it isn’t a PandaFM server.'
          : insecure
            ? 'Couldn’t reach it. Plain http:// only works in builds that allow it; use https:// if you can.'
            : 'Couldn’t reach that server. Check the address and that this device is online.',
    }
  }
  steps.push({ label: 'PandaFM server found', ok: true, detail: `version ${body.version}` })
  steps.push({ label: 'Database healthy', ok: !!body.database?.ok, detail: body.database?.ok ? undefined : body.database?.detail })
  steps.push({ label: 'Navidrome healthy', ok: !!body.navidrome?.ok, detail: body.navidrome?.ok ? undefined : body.navidrome?.detail })
  return { ok: steps.every((s) => s.ok), url, steps, message: steps.every((s) => s.ok) ? undefined : 'The server answered, but part of it isn’t healthy yet.' }
}
