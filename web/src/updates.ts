// Self-hosted Android updates (5.4.1): check this PandaFM server for a newer build, download and
// verify it natively, then open Android's installer. Nothing here can stop playback or sign anyone
// out; an automatic check that fails stays silent.

import { createStore, useStore } from 'zustand'
import type { UpdateCheck } from './platform/native.ts'
import { platform } from './platform/state.ts'

export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'none' | 'newer-installed' | 'downloading' | 'ready' | 'installing' | 'needs-permission' | 'error'

export interface UpdateState {
  phase: UpdatePhase
  installed: { versionName: string; versionCode: number } | null
  latest: UpdateCheck | null
  received: number
  total: number
  error: string | null
}

export const updateStore = createStore<UpdateState>()(() => ({ phase: 'idle', installed: null, latest: null, received: 0, total: 0, error: null }))
export const useUpdates = <T,>(selector: (s: UpdateState) => T) => useStore(updateStore, selector)

export const AUTO_CHECK_EVERY_MS = 12 * 60 * 60 * 1000
const LAST_CHECK = 'pandafm.updates.lastCheck'

/** At most one automatic check every 12 h (and never on navigation). */
export function shouldAutoCheck(lastMs: number | null, nowMs: number): boolean {
  return lastMs === null || !Number.isFinite(lastMs) || nowMs - lastMs >= AUTO_CHECK_EVERY_MS || nowMs < lastMs
}

/** One line for Settings › App. */
export function describe(s: UpdateState): string {
  switch (s.phase) {
    case 'checking': return 'Checking for updates…'
    case 'current': return 'PandaFM is up to date'
    case 'none': return 'This server hasn’t published an Android update'
    case 'newer-installed': return 'This device has a newer PandaFM than the server offers'
    case 'available': return `Update available: PandaFM ${s.latest?.versionName ?? ''}`.trim()
    case 'downloading': return s.total ? `Downloading… ${Math.floor((100 * s.received) / s.total)}%` : 'Downloading…'
    case 'ready': return `PandaFM ${s.latest?.versionName ?? ''} is downloaded and verified`.replace('  ', ' ')
    case 'installing': return 'Android’s installer is open'
    case 'needs-permission': return 'Allow PandaFM to install apps (Android asks once), then come back'
    case 'error': return s.error ?? 'Couldn’t check for updates'
    default: return ''
  }
}

async function loadInstalled() {
  if (!platform.updater || updateStore.getState().installed) return
  const info = await platform.updater.info()
  updateStore.setState({ installed: { versionName: info.versionName, versionCode: info.versionCode } })
}

/** "Check for updates" (manual: failures are shown; automatic: they stay silent). */
export async function checkForUpdates(manual: boolean): Promise<void> {
  const updater = platform.updater
  if (!updater) return
  const before = updateStore.getState().phase
  if (before === 'downloading' || before === 'installing') return
  if (manual) updateStore.setState({ phase: 'checking', error: null })
  try {
    await loadInstalled()
    const r = await updater.check()
    try {
      localStorage.setItem(LAST_CHECK, String(Date.now()))
    } catch {
      // private storage unavailable: just check again next time
    }
    const phase: UpdatePhase = r.status === 'available' ? (r.downloaded ? 'ready' : 'available') : r.status
    updateStore.setState({ phase, latest: r, error: null })
  } catch (err) {
    if (manual) updateStore.setState({ phase: 'error', error: err instanceof Error && err.message ? err.message : 'Couldn’t check for updates' })
  }
}

/** After start-up, at most every 12 h, silently. */
export function autoCheckForUpdates(now = Date.now()): void {
  if (!platform.updater) return
  let last: number | null = null
  try {
    const raw = localStorage.getItem(LAST_CHECK)
    last = raw === null ? null : Number(raw)
  } catch {
    last = null
  }
  if (shouldAutoCheck(last, now)) void checkForUpdates(false)
}

export async function downloadUpdate(): Promise<void> {
  const updater = platform.updater
  if (!updater) return
  updateStore.setState({ phase: 'downloading', received: 0, total: updateStore.getState().latest?.size ?? 0, error: null })
  const sub = await updater.addListener('updateProgress', (e) => updateStore.setState({ received: e.received, total: e.total }))
  try {
    await updater.download()
    updateStore.setState({ phase: 'ready' })
  } catch (err) {
    updateStore.setState({ phase: 'available', error: err instanceof Error ? err.message : 'The download failed' })
  } finally {
    void sub.remove()
  }
}

export async function cancelUpdate(): Promise<void> {
  await platform.updater?.cancel()
}

/** Opens Android's installer; if Android needs "Install unknown apps", opens that page and resumes on return. */
export async function installUpdate(): Promise<void> {
  const updater = platform.updater
  if (!updater) return
  try {
    const r = await updater.install()
    updateStore.setState({ phase: r.needsPermission ? 'needs-permission' : 'installing', error: null })
  } catch (err) {
    updateStore.setState({ phase: 'ready', error: err instanceof Error ? err.message : 'Couldn’t open the installer' })
  }
}

// Back from Android's "Install unknown apps" page (or the installer): carry on where we were.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    const phase = updateStore.getState().phase
    if (phase === 'needs-permission') void installUpdate()
    else if (phase === 'installing') updateStore.setState({ phase: 'ready' }) // the installer was closed without updating
  })
}
