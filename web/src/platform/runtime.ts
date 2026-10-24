import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PandaPlayerPlugin, PandaStoragePlugin } from './native'
import { savedServer } from './server'
import { configurePlatform } from './state'

/** Called once at start-up (main.tsx). In a browser nothing changes. */
export function initPlatform(): void {
  if (!Capacitor.isNativePlatform()) return
  configurePlatform({
    kind: 'android',
    server: savedServer(),
    localFileUrl: (uri) => Capacitor.convertFileSrc(uri), // served (with Range) by Capacitor's local server
    storage: registerPlugin<PandaStoragePlugin>('PandaStorage'),
    player: registerPlugin<PandaPlayerPlugin>('PandaPlayer'),
  })
}
