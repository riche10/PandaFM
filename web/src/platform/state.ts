// Where PandaFM is running and how to reach its server. Plain state with no
// Capacitor import, so every module (and every unit test) can use it; the
// Android runtime fills it in at start-up (platform/runtime.ts).

import type { PandaPlayerPlugin, PandaStoragePlugin } from './native'

export interface PlatformState {
  kind: 'web' | 'android'
  /** The PandaFM server, e.g. "https://music.example.com". Empty on the web: same origin. */
  server: string
  /** Turn a device file (content:// URI) into a URL the WebView can play. */
  localFileUrl: (uri: string) => string
  storage: PandaStoragePlugin | null
  /** Native Media3 playback (Android). When set, the player uses it instead of <audio>. */
  player: PandaPlayerPlugin | null
}

export const platform: PlatformState = {
  kind: 'web',
  server: '',
  localFileUrl: (uri) => uri,
  storage: null,
  player: null,
}

export const isNative = () => platform.kind === 'android'

export function configurePlatform(next: Partial<PlatformState>): void {
  Object.assign(platform, next)
}
