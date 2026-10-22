import { createStore, type StoreApi } from 'zustand/vanilla'
import type { Playlist, PlaylistSummary } from '../api/library'

// The playlist list shared by the sidebar, Library and "Add to playlist".
// Every change goes to Navidrome first; the list updates from its answer.

export interface PlaylistsState {
  playlists: PlaylistSummary[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Bumped after any change, so an open playlist page can reload. */
  version: number
  load(): Promise<void>
  create(name: string, trackIds?: string[]): Promise<Playlist>
  rename(id: string, name: string): Promise<Playlist>
  remove(id: string): Promise<void>
  addTracks(id: string, trackIds: string[]): Promise<Playlist>
  removeTrack(id: string, index: number, trackId: string): Promise<Playlist>
}

export interface PlaylistsDeps {
  list: () => Promise<{ playlists: PlaylistSummary[] }>
  create: (name: string, trackIds: string[]) => Promise<Playlist>
  rename: (id: string, name: string) => Promise<Playlist>
  remove: (id: string) => Promise<unknown>
  addTracks: (id: string, trackIds: string[]) => Promise<Playlist>
  removeTrack: (id: string, index: number, trackId: string) => Promise<Playlist>
}

function summary(playlist: Playlist): PlaylistSummary {
  const { tracks: _tracks, ...rest } = playlist
  return rest
}

export function createPlaylistsStore(api: PlaylistsDeps): StoreApi<PlaylistsState> {
  return createStore<PlaylistsState>()((set, get) => {
    const upsert = (playlist: Playlist) => {
      const others = get().playlists.filter((p) => p.id !== playlist.id)
      const exists = others.length !== get().playlists.length
      set((s) => ({
        playlists: exists
          ? s.playlists.map((p) => (p.id === playlist.id ? summary(playlist) : p))
          : [summary(playlist), ...others],
        version: s.version + 1,
      }))
      return playlist
    }

    return {
      playlists: [],
      status: 'idle',
      version: 0,

      async load() {
        if (get().status === 'idle') set({ status: 'loading' })
        try {
          const { playlists } = await api.list()
          set({ playlists, status: 'ready' })
        } catch {
          if (get().status !== 'ready') set({ status: 'error' })
        }
      },

      create: async (name, trackIds = []) => upsert(await api.create(name, trackIds)),
      rename: async (id, name) => upsert(await api.rename(id, name)),
      addTracks: async (id, trackIds) => upsert(await api.addTracks(id, trackIds)),
      removeTrack: async (id, index, trackId) => upsert(await api.removeTrack(id, index, trackId)),

      async remove(id) {
        await api.remove(id)
        set((s) => ({ playlists: s.playlists.filter((p) => p.id !== id), version: s.version + 1 }))
      },
    }
  })
}
