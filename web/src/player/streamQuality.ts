// Remote streaming quality (5.0), per device. Separate from offline download quality.
// Pure parts are unit-tested; the setting lives in localStorage on this device.

export type StreamQuality = 'auto' | 'original' | 'high' | 'low'
export type ResolvedQuality = 'original' | 'high' | 'low'

/** Auto: in the Android app, Original on Wi-Fi/unmetered and High (AAC ~256) on metered data;
 *  in a browser (network type unknowable) it means Original. */
export function resolveQuality(setting: StreamQuality, native: boolean, network: { metered: boolean; wifi: boolean } | null, aacPlayable = true): ResolvedQuality {
  if (!aacPlayable) return 'original' // e.g. Chromium builds without AAC: smaller streams wouldn't play at all
  if (setting !== 'auto') return setting
  if (!native || !network) return 'original'
  return network.metered && !network.wifi ? 'high' : 'original'
}

export function withQuality(url: string, quality: ResolvedQuality): string {
  return quality === 'original' ? url : `${url}${url.includes('?') ? '&' : '?'}quality=${quality}`
}

const KEY = 'pandafm.streaming'
const VALID: StreamQuality[] = ['auto', 'original', 'high', 'low']

export function loadQuality(storage: Pick<Storage, 'getItem'> | null): StreamQuality {
  try {
    const v = storage?.getItem(KEY) as StreamQuality | null
    return v && VALID.includes(v) ? v : 'auto'
  } catch {
    return 'auto'
  }
}

/** Whether this device has a saved choice (an empty WebView storage must not count as "auto"). */
export function hasSavedQuality(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    const v = storage?.getItem(KEY)
    return v != null && loadQuality(storage) === v
  } catch {
    return false
  }
}

export function saveQuality(storage: Pick<Storage, 'setItem'> | null, q: StreamQuality): void {
  try {
    storage?.setItem(KEY, q)
  } catch {
    // storage full or blocked: keep it for this session only
  }
}
