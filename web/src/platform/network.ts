// The device's network (Android: from the native plugin; browsers: unknown) and the
// streaming quality it implies right now.
import { hasSavedQuality, loadQuality, type ResolvedQuality, resolveQuality, saveQuality, type StreamQuality } from '../player/streamQuality.ts'
import { isNative, onPlatformChange, platform } from './state.ts'

let network: { metered: boolean; wifi: boolean } | null = null
let setting: StreamQuality = loadQuality(typeof localStorage === 'undefined' ? null : localStorage)
const listeners = new Set<() => void>()

export function startNetworkWatch(): void {
  // 5.5: only a choice actually saved here goes to the native player at start-up. With nothing saved
  // (e.g. the WebView's storage was cleared), the native setting wins and the app adopts it, so start-up
  // and re-renders can never turn a fixed "Original" back into "Auto".
  const saved = typeof localStorage === 'undefined' ? null : localStorage
  if (hasSavedQuality(saved)) void platform.player?.setPreferences({ streamQuality: setting }).catch(() => undefined)
  else adoptNativeQuality()
  const storage = platform.storage
  if (!storage) return
  storage.getNetwork().then((n) => { network = n; listeners.forEach((l) => l()) }, () => undefined)
  void storage.addListener('network', (n) => { network = n; listeners.forEach((l) => l()) })
}

export const streamQualitySetting = () => setting
const QUALITIES: readonly StreamQuality[] = ['auto', 'original', 'high', 'low']
const ADOPT_RETRY_MS = [1000, 4000] // a fallback; the player becoming available is the real trigger
const ADOPT_MAX_ATTEMPTS = 4
let adoption: { cancel: () => void } | null = null

async function readNativeQuality(): Promise<StreamQuality | null> {
  try {
    const r = await platform.player?.getDiagnostics()
    const q = r ? (JSON.parse(r.diagnostics) as { streamQualitySetting?: string }).streamQualitySetting : undefined
    return QUALITIES.includes(q as StreamQuality) ? (q as StreamQuality) : null
  } catch {
    return null // the player isn't up yet
  }
}

/**
 * 5.5: with nothing saved on this device, the app takes the native player's setting instead of overwriting
 * it. If the read comes too early (no player yet, or it isn't answering), it is retried once the player
 * becomes available (configured, or its first event), with two timed fallbacks: at most 4 attempts.
 * A choice made in Settings meanwhile cancels it, so a late read can never overwrite the user.
 */
function adoptNativeQuality(): void {
  adoption?.cancel()
  let done = false
  let attempts = 0
  let busy = false
  const cleanups: (() => void)[] = []
  const finish = () => {
    if (done) return
    done = true
    cleanups.forEach((c) => c())
    if (adoption === handle) adoption = null
  }
  const handle = { cancel: finish }
  adoption = handle
  const attempt = async () => {
    if (done || busy || attempts >= ADOPT_MAX_ATTEMPTS) return
    busy = true
    attempts++
    const q = await readNativeQuality()
    busy = false
    if (done) return // the user chose meanwhile
    if (q) {
      setting = q
      saveQuality(typeof localStorage === 'undefined' ? null : localStorage, q)
      listeners.forEach((l) => l())
      finish()
    } else if (attempts >= ADOPT_MAX_ATTEMPTS) {
      finish()
    } else {
      listenToPlayer()
    }
  }
  let listening = false
  const listenToPlayer = () => { // the player's first state/queue event means it is up: retry then (once)
    const player = platform.player
    if (listening || !player) return
    listening = true
    let fired = false
    const once = () => { if (!fired) { fired = true; void attempt() } }
    for (const event of ['state', 'queue'] as const) {
      void player.addListener(event as 'state', once as never).then((h) => {
        if (done) void h.remove()
        else cleanups.push(() => void h.remove())
      }, () => undefined)
    }
  }
  cleanups.push(onPlatformChange(() => { if (platform.player) { listenToPlayer(); void attempt() } }))
  for (const ms of ADOPT_RETRY_MS) {
    const t = setTimeout(() => void attempt(), ms)
    cleanups.push(() => clearTimeout(t))
  }
  void attempt()
}

/** Test only: reset this module's state. */
export function resetQualityForTests(q: StreamQuality = 'auto'): void {
  adoption?.cancel()
  setting = q
}

export function setStreamQuality(q: StreamQuality): void {
  adoption?.cancel() // the user's choice wins over any pending adoption
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
