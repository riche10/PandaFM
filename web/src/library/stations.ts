import { useEffect } from 'react'
import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'
import { type RadioStation, stationsApi } from '../api/radio'

// Your saved stations (server-side: the same on the phone, Walkman and desktop).

const store = createStore<{ stations: RadioStation[] | null; error: string | null }>()(() => ({ stations: null, error: null }))

export async function reloadStations(): Promise<void> {
  try {
    store.setState({ stations: await stationsApi.list(), error: null })
  } catch (err) {
    // Offline: keep showing the stations we already know.
    store.setState({ error: err instanceof Error ? err.message : 'Couldn’t load your stations.' })
  }
}

export function useStations() {
  const state = useStore(store)
  useEffect(() => {
    if (state.stations === null) void reloadStations()
  }, [state.stations])
  return state
}

export { filterGenres, stationSubtitle } from './stationText'
