import { createStore, type StoreApi } from 'zustand/vanilla'
import type { FavoriteKind } from '../api/library'

// Favorites live in Navidrome. Data from the API already says whether each
// song/album/artist is a favorite; this store only remembers changes made
// in this session, so every heart for the same item agrees immediately,
// even in lists loaded before the change.

export interface FavoritesState {
  /** `${kind}:${id}` → favorite, for items changed in this session */
  overrides: Record<string, boolean>
  /** Bumped after every successful change, so favorite lists can reload. */
  version: number
  toggle(kind: FavoriteKind, id: string, current: boolean): Promise<void>
}

export interface FavoritesDeps {
  setFavorite: (kind: FavoriteKind, id: string, favorite: boolean) => Promise<unknown>
  notify: (message: string, tone?: 'info' | 'error') => void
}

export const favoriteKey = (kind: FavoriteKind, id: string) => `${kind}:${id}`

export function isFavorite(state: Pick<FavoritesState, 'overrides'>, kind: FavoriteKind, id: string, fromServer: boolean): boolean {
  return state.overrides[favoriteKey(kind, id)] ?? fromServer
}

export function createFavoritesStore({ setFavorite, notify }: FavoritesDeps): StoreApi<FavoritesState> {
  return createStore<FavoritesState>()((set) => ({
    overrides: {},
    version: 0,
    async toggle(kind, id, current) {
      const key = favoriteKey(kind, id)
      const next = !current
      set((s) => ({ overrides: { ...s.overrides, [key]: next } })) // optimistic
      try {
        await setFavorite(kind, id, next)
        set((s) => ({ version: s.version + 1 }))
        notify(next ? 'Added to Favorites' : 'Removed from Favorites')
      } catch (err) {
        set((s) => ({ overrides: { ...s.overrides, [key]: current } })) // roll back
        notify(err instanceof Error ? err.message : 'Couldn’t update Favorites.', 'error')
      }
    },
  }))
}
