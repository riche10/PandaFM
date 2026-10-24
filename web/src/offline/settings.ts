import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

// Device preferences for downloads and playback, remembered on this device.

export interface OfflineSettings {
  defaultProfile: string
  syncPolicy: 'manual' | 'wifi' | 'any'
  concurrency: number
  preferLocal: boolean // play the downloaded file when there is one
  streamFallback: boolean // otherwise stream from the server
}

const KEY = 'pandafm.offline-settings'
export const DEFAULT_SETTINGS: OfflineSettings = { defaultProfile: 'original', syncPolicy: 'wifi', concurrency: 2, preferLocal: true, streamFallback: true }

function load(): OfflineSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export const settingsStore = createStore<OfflineSettings>()(() => load())
settingsStore.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s))
  } catch {
    // not persisted; still used for this session
  }
})

export const useOfflineSettings = () => useStore(settingsStore)
export const updateSettings = (change: Partial<OfflineSettings>) => settingsStore.setState(change)
