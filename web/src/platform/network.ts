// The device's network (Android: from the native plugin; browsers: unknown) and the
// streaming quality it implies right now.
import { loadQuality, type ResolvedQuality, resolveQuality, saveQuality, type StreamQuality } from '../player/streamQuality.ts'
import { isNative, platform } from './state.ts'

let network: { metered: boolean; wifi: boolean } | null = null
let setting: StreamQuality = loadQuality(typeof localStorage === 'undefined' ? null : localStorage)
const listeners = new Set<() => void>()

export function startNetworkWatch(): void {
  void platform.player?.setPreferences({ streamQuality: setting }).catch(() => undefined)
  const storage = platform.storage
  if (!storage) return
  storage.getNetwork().then((n) => { network = n; listeners.forEach((l) => l()) }, () => undefined)
  void storage.addListener('network', (n) => { network = n; listeners.forEach((l) => l()) })
}

export const streamQualitySetting = () => setting
export function setStreamQuality(q: StreamQuality): void {
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
