import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { presetsApi, type RadioPreset } from '../api/radio'

// Panda Radio presets (built-ins with your names, then your own), shared by
// Home, Settings and the Autoplay picker. They live on the server, so every
// device sees the same ones.

const store = createStore<{ presets: RadioPreset[] | null; error: string | null }>()(() => ({ presets: null, error: null }))

export async function reloadPresets(): Promise<void> {
  try {
    store.setState({ presets: await presetsApi.list(), error: null })
  } catch (err) {
    store.setState({ error: err instanceof Error ? err.message : 'Couldn’t load radio presets.' })
  }
}

export function usePresets() {
  const state = useStore(store)
  useEffect(() => {
    if (state.presets === null) void reloadPresets()
  }, [state.presets])
  return state
}

export const TAGLINES: Record<string, string> = {
  panda: 'Balanced',
  familiar: 'Songs you love',
  discovery: 'Explore your library',
  study: 'Steady focus',
  chaos: 'Anything goes',
}

export const PRESET_ICONS: Record<string, string> = { panda: 'paw', familiar: 'heart', discovery: 'compass', study: 'book', chaos: 'sparkle' }

export function presetSubtitle(p: RadioPreset): string {
  if (p.kind === 'custom') return `Your preset · based on ${p.base_name}`
  if (p.default_name && p.name !== p.default_name) return `Based on ${p.default_name}`
  return TAGLINES[p.id] ?? p.description
}
