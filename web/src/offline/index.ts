import { useStore } from 'zustand'
import { apiSend, apiUrl } from '../api/client'
import { type CoverSize, coverUrl, streamUrl } from '../api/library'
import { isNative, platform } from '../platform/state'
import { collectionProgress, DownloadManager, type OfflineState } from './manager'
import { createSourceResolver } from './playback'
import { settingsStore } from './settings'
import { IndexedDbManifestStore } from './store'
import type { Manifest } from './types'

// Offline features exist only in the Android app. In a browser this module
// is inert: the resolver always streams and the manager is never created.

let manager: DownloadManager | null = null
const network = { connected: true, metered: false, wifi: true }
const reconnectListeners = new Set<() => void>()

export const isOnline = () => network.connected && (typeof navigator === 'undefined' || navigator.onLine !== false)

/** Something to run whenever the network comes back (e.g. sending buffered listening events). */
export function onReconnect(listener: () => void): void {
  reconnectListeners.add(listener)
}

function networkChanged(next: { connected: boolean; metered: boolean; wifi: boolean }) {
  const wasOnline = isOnline()
  Object.assign(network, next)
  if (!wasOnline && isOnline()) {
    for (const listener of reconnectListeners) listener()
    void autoSync()
  }
}

/** Keep "keep downloaded" collections in sync, respecting the Wi-Fi / data setting. */
export async function autoSync(): Promise<void> {
  const policy = settingsStore.getState().syncPolicy
  const allowed = policy === 'any' ? network.connected : policy === 'wifi' ? network.connected && (network.wifi || !network.metered) : false
  if (manager && allowed) await manager.syncAll().catch(() => undefined)
}

export function startOffline(): void {
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => networkChanged({ ...network, connected: true }))
    window.addEventListener('offline', () => networkChanged({ ...network, connected: false }))
  }
  const storage = platform.storage
  if (!isNative() || !storage) return
  manager = new DownloadManager({
    prepare: (body) => apiSend<Manifest>('POST', '/downloads/prepare', body),
    store: new IndexedDbManifestStore(),
    native: storage,
    absoluteUrl: (path) => `${platform.server}${path}`,
    settings: () => settingsStore.getState(),
  })
  void storage.addListener('jobUpdate', (job) => void manager?.onJob(job))
  void storage.addListener('network', networkChanged)
  void storage.getNetwork().then(networkChanged).catch(() => undefined)
  void manager.init().then(autoSync).catch(() => undefined)
}

export const offline = () => manager

/** The player's source for a song: downloaded file, server stream, or null (unavailable offline). */
export const resolveSource = createSourceResolver({
  track: (id) => manager?.state.getState().tracks[id],
  settings: () => settingsStore.getState(),
  online: isOnline,
  // The native player reads content:// itself (no WebView copy); <audio> needs Capacitor's local URL.
  localFileUrl: (uri) => (platform.player ? uri : platform.localFileUrl(uri)),
  streamUrl,
})

/** Artwork: the copy saved on the device when there is one, otherwise the server's. */
export function artworkSrc(coverArtId: string, size: CoverSize): string {
  const local = manager?.state.getState().artwork[coverArtId]
  return local ? platform.localFileUrl(local) : coverUrl(coverArtId, size)
}

/** Artwork for the native lock screen: the saved copy on the device, else the server's cover (absolute URL). */
export function nativeArtworkUri(coverArtId: string | null): string | null {
  if (!coverArtId) return null
  return manager?.state.getState().artwork[coverArtId] ?? coverUrl(coverArtId, 600)
}

/** A cover the WebView can show directly (web, or saved on the device); null when Android must fetch it. */
export function directArtworkSrc(coverArtId: string, size: CoverSize): string | null {
  const local = manager?.state.getState().artwork[coverArtId]
  if (local) return platform.localFileUrl(local)
  return isNative() ? null : coverUrl(coverArtId, size)
}

/** Save a collection's artwork on the device once, for offline browsing and the lock screen. */
export async function cacheArtwork(coverArtIds: (string | null)[]): Promise<void> {
  const storage = platform.storage
  if (!manager || !storage) return
  const known = manager.state.getState().artwork
  for (const id of new Set(coverArtIds)) {
    if (!id || known[id]) continue
    try {
      const blob = await (await fetch(apiUrl(`/covers/${encodeURIComponent(id)}?size=600`))).blob()
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
      })
      const { uri } = await storage.writeFile({ relativePath: `.pandafm/artwork/${id.replace(/[^A-Za-z0-9_-]/g, '_')}.jpg`, base64 })
      await manager.rememberArtwork(id, uri)
    } catch {
      // Artwork is a nicety; the music still downloads.
    }
  }
}

const emptyState: OfflineState = { ready: false, tracks: {}, collections: {}, artwork: {}, progress: {}, paused: false }
const fallbackStore = { getState: () => emptyState, subscribe: () => () => {} } as unknown as DownloadManager['state']

export function useOffline<T>(selector: (s: OfflineState) => T): T {
  return useStore(manager?.state ?? fallbackStore, selector)
}

export const useOfflineTrack = (trackId: string) => useOffline((s) => s.tracks[trackId])
export const useCollectionProgress = (key: string) => useOffline((s) => collectionProgress(s, key))
export { collectionProgress }
