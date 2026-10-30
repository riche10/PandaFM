// The device's network (Android: from the native plugin; browsers: unknown) and the
// streaming quality it implies right now.
import { hasSavedQuality, loadQuality, type ResolvedQuality, resolveQuality, saveQuality, type StreamQuality } from '../player/streamQuality.ts'
import { isNative, platform } from './state.ts'

let network: { metered: boolean; wifi: boolean } | null = null
let setting: StreamQuality = loadQuality(typeof localStorage === 'undefined' ? null : localStorage)
const listeners = new Set<() => void>()

export function startNetworkWatch(): void {
  // 5.5: only a choice actually saved here goes to the native player at start-up. With nothing saved
  // (e.g. the WebView's storage was cleared), the native setting wins and the app adopts it, so start-up
  // and re-renders can never turn a fixed "Original" back into "Auto".
  const saved = typeof localStorage === 'undefined' ? null : localStorage
  if (hasSavedQuality(saved)) void platform.player?.setPreferences({ streamQuality: setting }).catch(() => undefined)
  else void adoptNativeQuality()
  const storage = platform.storage
  if (!storage) return
  storage.getNetwork().then((n) => { network = n; listeners.forEach((l) => l()) }, () => undefined)
  void storage.addListener('network', (n) => { network = n; listeners.forEach((l) => l()) })
}

export const streamQualitySetting = () => setting
async function adoptNativeQuality(): Promise<void> {
  try {
    const r = await platform.player?.getDiagnostics()
    const q = r ? (JSON.parse(r.diagnostics) as { streamQualitySetting?: string }).streamQualitySetting : undefined
    if (q === 'auto' || q === 'original' || q === 'high' || q === 'low') {
      setting = q
      saveQuality(typeof localStorage === 'undefined' ? null : localStorage, q)
      listeners.forEach((l) => l())
    }
  } catch {
    // the browser, or the player isn't up yet: nothing to adopt
  }
}

export function setStreamQuality(q: StreamQuality): void {
  if (q === setting) return // the same choice again: nothing changes, nothing is re-planned
  setting = q
  void platform.player?.setPreferences({ streamQuality: q }).catch(() => undefined) // Android: the service picks each song's stream
  saveQuality(typeof localStorage === 'undefined' ? null : localStorage, q)
  listeners.forEach((l) => l())
}
/** Can this browser decode AAC? (Android's ExoPlayer always can.) */
export const aacPlayable = (() => {
  try {
    return isNative() || typeof Audio === 'undefined' || new Audio().canPlayType('audio/mp4; codecs="mp4a.40.2"') !== ''
  } catch {
    return true
  }
})()
export const currentStreamQuality = (): ResolvedQuality => resolveQuality(setting, isNative(), network, aacPlayable)
export const currentNetwork = () => network
export function onStreamQualityChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
