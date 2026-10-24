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
