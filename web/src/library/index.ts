import { useStore } from 'zustand'
import { type FavoriteKind, playlistApi, listPlaylists, setFavorite } from '../api/library'
import { createFavoritesStore, isFavorite } from './favorites'
import { createPlaylistsStore } from './playlists'
import { toast } from './toasts'

export const favoritesStore = createFavoritesStore({ setFavorite, notify: toast })

export const playlistsStore = createPlaylistsStore({
  list: () => listPlaylists(),
  create: playlistApi.create,
  rename: playlistApi.rename,
  remove: playlistApi.remove,
  addTracks: playlistApi.addTracks,
  removeTrack: playlistApi.removeTrack,
})

/** Whether an item is a favorite: this session's change if any, else what the API said. */
export function useFavorite(kind: FavoriteKind, id: string, fromServer: boolean): boolean {
  return useStore(favoritesStore, (s) => isFavorite(s, kind, id, fromServer))
}

export const toggleFavorite = (kind: FavoriteKind, id: string, current: boolean) =>
  favoritesStore.getState().toggle(kind, id, current)

export const useFavoritesVersion = () => useStore(favoritesStore, (s) => s.version)

export const usePlaylists = () => useStore(playlistsStore, (s) => s.playlists)
export const usePlaylistsStatus = () => useStore(playlistsStore, (s) => s.status)
export const usePlaylistsVersion = () => useStore(playlistsStore, (s) => s.version)
export const playlists = () => playlistsStore.getState()

export { toast } from './toasts'
