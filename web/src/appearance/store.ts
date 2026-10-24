import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { DEFAULT_APPEARANCE, type Appearance, checkCustomTheme } from './resolve.ts'
import { ACCENTS, THEMES } from './themes.ts'
import { isHex } from './color.ts'

// Appearance is chosen per device (desktop light, Walkman AMOLED, …) and kept
// on the device. Anything unreadable falls back to safe defaults.

const KEY = 'pandafm.appearance'

export function loadAppearance(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Appearance {
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(storage?.getItem(KEY) ?? '{}') ?? {}
  } catch {
    return DEFAULT_APPEARANCE
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_APPEARANCE
  const custom = raw.custom ? checkCustomTheme(raw.custom) : null
  const theme = typeof raw.theme === 'string' && (raw.theme === 'system' || THEMES[raw.theme] || (raw.theme === 'custom' && custom?.ok)) ? raw.theme : DEFAULT_APPEARANCE.theme
  return {
    theme,
    artwork: raw.artwork === 'off' || raw.artwork === 'immersive' ? raw.artwork : 'subtle',
    accent: typeof raw.accent === 'string' && ACCENTS.some((a) => a.id === raw.accent) ? raw.accent : 'theme',
    customAccent: isHex(raw.customAccent) ? raw.customAccent : DEFAULT_APPEARANCE.customAccent,
    custom: custom?.ok ? custom.theme : null,
  }
}

export function saveAppearance(a: Appearance, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(KEY, JSON.stringify(a))
  } catch {
    // kept for this session only
  }
}

export const appearanceStore = createStore<Appearance>()(() => loadAppearance())
appearanceStore.subscribe((a) => saveAppearance(a))

export const useAppearance = () => useStore(appearanceStore)
export const setAppearance = (change: Partial<Appearance>) => appearanceStore.setState(change)
/** The escape hatch: back to Panda Classic with default options. */
export const resetAppearance = () => appearanceStore.setState({ ...DEFAULT_APPEARANCE, custom: appearanceStore.getState().custom })
