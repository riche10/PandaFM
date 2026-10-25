// The Android-only native plugin (android/app/src/main/java/.../PandaStoragePlugin.java).
// Storage Access Framework folder access and a background download queue.

export interface NativeJob {
  id: string // the track id: one active download per track
  url: string // absolute https URL of /api/downloads/files/...
  relativePath: string // Music/Artist/Album/01 - Title.ext inside the chosen folder
  expectedBytes: number | null
  sha256: string | null
  mimeType: string
}

export interface NativeJobState {
  id: string
  status: 'queued' | 'running' | 'paused' | 'done' | 'failed'
  bytes: number
  total: number | null
  uri?: string // content:// of the finished file
  sha256?: string
  error?: string
  retryable?: boolean
}

export interface PandaStoragePlugin {
  pickDirectory(): Promise<{ uri: string; name: string }>
  getDirectory(): Promise<{ uri: string | null; name: string | null; writable: boolean }>
  getStorageInfo(): Promise<{ freeBytes: number | null; totalBytes: number | null }>
  enqueue(options: { jobs: NativeJob[]; concurrency: number; allowMetered: boolean }): Promise<void>
  getJobs(): Promise<{ jobs: NativeJobState[] }>
  acknowledge(options: { ids: string[] }): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  cancel(options: { ids: string[] }): Promise<void>
  deleteFile(options: { uri: string }): Promise<{ deleted: boolean }>
  stat(options: { uri: string }): Promise<{ exists: boolean; size: number }>
  writeFile(options: { relativePath: string; base64: string }): Promise<{ uri: string }>
  getNetwork(): Promise<{ connected: boolean; metered: boolean; wifi: boolean }>
  addListener(event: 'jobUpdate', listener: (state: NativeJobState) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'network', listener: (state: { connected: boolean; metered: boolean; wifi: boolean }) => void): Promise<{ remove: () => Promise<void> }>
}

/**
 * The native queue (web/android/.../PandaPlayerPlugin.java, 5.0.1). On Android the
 * playback service owns the queue; the app sends commands and mirrors the snapshots
 * it publishes. Complex arguments travel as JSON strings.
 */
export interface PandaPlayerPlugin {
  getSnapshot(): Promise<{ snapshot: string }>
  replaceQueue(options: { tracks: string; startIndex: number; source: string; shuffle: boolean; play: boolean }): Promise<void>
  applyRadio(options: { picks: string; source: string; seedTrack: string; keepCurrent: boolean; autoplay: boolean }): Promise<void>
  startRadio(options: { preset: string; seedKind?: string; seedId?: string }): Promise<void>
  playNext(options: { tracks: string }): Promise<void>
  addToQueue(options: { tracks: string }): Promise<void>
  remove(options: { uid: string }): Promise<void>
  move(options: { uid: string; direction: number }): Promise<void>
  clear(options: { which: string }): Promise<void>
  jumpTo(options: { uid: string }): Promise<void>
  toggleShuffle(): Promise<void>
  cycleRepeat(): Promise<void>
  endRadio(): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  seek(options: { position: number }): Promise<void>
  setVolume(options: { volume: number }): Promise<void>
  setPreferences(options: { streamQuality?: string; autoplayEnabled?: boolean; autoplayPreset?: string }): Promise<void>
  setOfflineCatalog(options: { catalog: string }): Promise<void>
  migrate(options: { snapshot: string }): Promise<{ migrated: boolean }>
  addListener(event: 'queue', listener: (e: { snapshot: string; reason: string }) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'state', listener: (e: NativeState) => void): Promise<{ remove: () => Promise<void> }>
}

export interface NativeState {
  status: string
  positionMs: number
  durationMs: number
  error: string | null
  gen: number
}

/** Android sign-in (web/android/.../PandaAuthPlugin.java). The refresh token stays native, Keystore-encrypted. */
export interface PandaAuthPlugin {
  status(): Promise<{ signedIn: boolean; username: string | null }>
  signIn(options: { server: string; username: string; password: string; deviceName?: string }): Promise<{ username: string }>
  setup(options: { server: string; setupToken: string; username: string; password: string; deviceName?: string }): Promise<{ username: string }>
  accessToken(options?: { forceRefresh?: boolean }): Promise<{ token: string | null }>
  signOut(): Promise<void>
}
