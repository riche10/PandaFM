import { apiGet } from './client'

// Mirrors api/app/schemas/library.py. Ids are Navidrome ids in Stage 2.

export interface Track {
  id: string
  title: string
  artist: string
  artist_id: string | null
  album: string | null
  album_id: string | null
  cover_art_id: string | null
  duration_seconds: number | null
  track_number: number | null
  disc_number: number | null
  year: number | null
  genres: string[]
  content_type: string | null
  suffix: string | null
  bitrate_kbps: number | null
}

export interface AlbumSummary {
  id: string
  name: string
  artist: string
  artist_id: string | null
  cover_art_id: string | null
  year: number | null
  track_count: number | null
  duration_seconds: number | null
  genres: string[]
}

export interface Album extends AlbumSummary {
  tracks: Track[]
}

export interface ArtistSummary {
  id: string
  name: string
  album_count: number | null
  cover_art_id: string | null
}

export interface Artist extends ArtistSummary {
  albums: AlbumSummary[]
}

export type AlbumListKind = 'newest' | 'recent' | 'frequent' | 'random' | 'alphabetical'

export interface AlbumList {
  kind: AlbumListKind
  offset: number
  albums: AlbumSummary[]
}

export interface SearchResults {
  query: string
  tracks: Track[]
  albums: AlbumSummary[]
  artists: ArtistSummary[]
}

const id = encodeURIComponent

export const searchLibrary = (query: string, signal?: AbortSignal) =>
  apiGet<SearchResults>(`/search?${new URLSearchParams({ q: query })}`, signal)

export const listAlbums = (kind: AlbumListKind, signal?: AbortSignal, size = 30) =>
  apiGet<AlbumList>(`/albums?${new URLSearchParams({ list: kind, size: String(size) })}`, signal)

export const getAlbum = (albumId: string, signal?: AbortSignal) =>
  apiGet<Album>(`/albums/${id(albumId)}`, signal)

export const listArtists = (signal?: AbortSignal) =>
  apiGet<{ artists: ArtistSummary[] }>('/artists', signal)

export const getArtist = (artistId: string, signal?: AbortSignal) =>
  apiGet<Artist>(`/artists/${id(artistId)}`, signal)

export const getTrack = (trackId: string, signal?: AbortSignal) =>
  apiGet<Track>(`/tracks/${id(trackId)}`, signal)

/** Artwork sizes the UI asks for. A few fixed sizes keep Navidrome's resize cache warm. */
export type CoverSize = 96 | 300 | 600

export const coverUrl = (coverArtId: string, size: CoverSize) =>
  `/api/covers/${id(coverArtId)}?size=${size}`

/** Same-origin audio URL. Navidrome credentials are added server-side. */
export const streamUrl = (trackId: string) => `/api/tracks/${id(trackId)}/stream`
