import { apiGet } from './client'
import type { AlbumSummary, GenreSummary, Track } from './library'

// Explore your own library (server: api/app/routers/explore.py). Everything is
// derived from your Navidrome library and PandaFM's listening history.

export interface TopGenres {
  source: 'history' | 'library'
  genres: GenreSummary[]
}

export interface GenreDetail {
  genre: GenreSummary
  tags: string[]
  artists: { id: string; name: string; songs: number; cover_art_id: string | null }[]
  related: GenreSummary[]
}

export interface DecadeSummary {
  decade: number
  label: string
  albums: number
  songs: number
}

export interface SmartCollection {
  id: string
  name: string
  description: string
  count: number | null
  link: string | null
}

export interface BrowseFilters {
  genre?: string | null
  decade?: number | null
  favorites?: boolean
  lossless?: boolean
  hires?: boolean
  unplayed?: boolean
}

const query = (params: Record<string, string | number | boolean | null | undefined>) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== false && v !== '') q.set(k, String(v))
  return q.toString()
}

export const exploreApi = {
  genres: (sort: 'songs' | 'name' = 'songs', signal?: AbortSignal) => apiGet<GenreSummary[]>(`/genres?sort=${sort}`, signal),
  topGenres: (limit = 8, signal?: AbortSignal) => apiGet<TopGenres>(`/genres/top?limit=${limit}`, signal),
  genre: (key: string, signal?: AbortSignal) => apiGet<GenreDetail>(`/genres/${encodeURIComponent(key)}`, signal),
  decades: (signal?: AbortSignal) => apiGet<DecadeSummary[]>('/library/decades', signal),
  albums: (f: BrowseFilters, order: 'name' | 'year' | 'artist' | 'random', offset: number, limit: number, signal?: AbortSignal) =>
    apiGet<{ albums: AlbumSummary[]; offset: number; total: number }>(`/browse/albums?${query({ genre: f.genre, decade: f.decade, favorites: f.favorites, order, offset, limit })}`, signal),
  tracks: (f: BrowseFilters, order: 'artist' | 'title' | 'recent' | 'random', offset: number, limit: number, signal?: AbortSignal) =>
    apiGet<{ tracks: Track[]; offset: number; total: number }>(`/browse/tracks?${query({ ...f, order, offset, limit })}`, signal),
  related: (albumId: string, signal?: AbortSignal) =>
    apiGet<{ album: AlbumSummary; reason: string; score: number }[]>(`/albums/${encodeURIComponent(albumId)}/related`, signal),
  collections: (signal?: AbortSignal) => apiGet<SmartCollection[]>('/collections', signal),
  collectionTracks: (id: string, order: 'artist' | 'random', offset: number, limit: number, signal?: AbortSignal) =>
    apiGet<{ tracks: Track[]; offset: number; total: number }>(`/collections/${encodeURIComponent(id)}/tracks?${query({ order, offset, limit })}`, signal),
}

export { anyFilter, type LibraryFilterState, readFilters, writeFilters } from '../library/filters'
