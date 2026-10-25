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

/** One native player event. `gen` ties it to the load() that caused it, so stale events are ignored. */
export interface NativePlayerEvent {
  gen: number
  type: 'loading' | 'playing' | 'paused' | 'time' | 'ended' | 'error'
  position?: number
  duration?: number | null
  kind?: 'network' | 'decode' | 'unsupported' | 'missing' | 'unknown'
  reason?: string // e.g. 'timeout', 'http_status', 'cleartext', 'not_found', 'no_permission'
  code?: string // Media3 error code name, for diagnostics only
}

/** Lock screen, notification, Bluetooth and headset buttons, handed to the shared queue. */
export interface NativeRemoteCommand {
  action: 'play' | 'pause' | 'next' | 'previous' | 'seek'
  position?: number
}

/** The Android-only native player (web/android/.../PandaPlayerPlugin.java): Media3 / ExoPlayer. */
export interface PandaPlayerPlugin {
  load(options: { gen: number; url: string; trackId: string; title: string; artist: string; album: string | null; artworkUrl: string | null; durationSeconds: number | null }): Promise<void>
  play(options: { gen: number }): Promise<void>
  pause(): Promise<void>
  seek(options: { position: number }): Promise<void>
  stop(): Promise<void>
  setVolume(options: { volume: number }): Promise<void>
  getState(): Promise<{ engine: string; isPlaying: boolean; position: number; duration: number | null; uriScheme: string | null; mediaId: string | null }>
  addListener(event: 'state', listener: (event: NativePlayerEvent) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'remote', listener: (command: NativeRemoteCommand) => void): Promise<{ remove: () => Promise<void> }>
}

/** Android sign-in (web/android/.../PandaAuthPlugin.java). The refresh token stays native, Keystore-encrypted. */
export interface PandaAuthPlugin {
  status(): Promise<{ signedIn: boolean; username: string | null }>
  signIn(options: { server: string; username: string; password: string; deviceName?: string }): Promise<{ username: string }>
  setup(options: { server: string; setupToken: string; username: string; password: string; deviceName?: string }): Promise<{ username: string }>
  accessToken(options?: { forceRefresh?: boolean }): Promise<{ token: string | null }>
  signOut(): Promise<void>
}
