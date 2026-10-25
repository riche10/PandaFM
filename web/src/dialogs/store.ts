import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { PlaylistSummary, Track } from '../api/library'

// App-wide dialogs, opened from anywhere (track menus, sidebar, pages) and
// rendered once by <DialogHost />.

export type DialogRequest =
  | { type: 'add-to-playlist'; tracks: Track[] }
  | { type: 'new-playlist'; tracks: Track[] }
  | { type: 'rename-playlist'; playlist: PlaylistSummary }
  | { type: 'delete-playlist'; playlist: PlaylistSummary; onDeleted?: () => void }
  | { type: 'why'; track: Track; reasons: string[]; modeLabel: string | null }
  | { type: 'preset'; preset: import('../api/radio').RadioPreset | null }
  | { type: 'station'; station: import('../api/radio').RadioStation | null; prefill?: { name: string; genres: string[] } }
  | { type: 'track-info'; track: Track }
  | { type: 'album-info'; album: import('../api/library').Album }
  | { type: 'filters'; kind: 'albums' | 'songs'; value: import('../api/explore').LibraryFilterState; onApply: (f: import('../api/explore').LibraryFilterState) => void }
  | { type: 'download'; target: { kind: 'track' | 'album' | 'playlist' | 'favorites'; id: string | null; name: string } }

const dialogStore = createStore<{ current: DialogRequest | null }>()(() => ({ current: null }))

export const openDialog = (request: DialogRequest) => dialogStore.setState({ current: request })
export const closeDialog = () => dialogStore.setState({ current: null })
export const useDialog = () => useStore(dialogStore, (s) => s.current)
