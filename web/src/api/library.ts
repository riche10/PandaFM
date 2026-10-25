import { apiGet, apiSend, apiUrl } from './client'

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
  favorite: boolean
  album_artist?: string | null
  sample_rate?: number | null
  bit_depth?: number | null
  channels?: number | null
  size_bytes?: number | null
  quality?: AudioQuality | null
}

/** What a file's audio really is (decided by the server; see api/app/audio/quality.py). */
export interface AudioQuality {
  codec: string
  lossless: boolean | null
  hi_res: boolean
  badge: 'LOSSLESS' | 'HI-RES' | null
  detail: string | null
  short: string | null
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
  favorite: boolean
  genre_tags?: GenreTag[] // deduplicated, for chips
}

export interface Album extends AlbumSummary {
  tracks: Track[]
}

export interface ArtistSummary {
  id: string
  name: string
  album_count: number | null
  cover_art_id: string | null
  favorite: boolean
}

export interface Artist extends ArtistSummary {
  albums: AlbumSummary[]
  genres?: GenreTag[] // dominant genres
}

/** A genre as PandaFM knows it: canonical key (for /genres/:key) and the library's own spelling. */
export interface GenreTag {
  key: string
  name: string
}

export interface GenreSummary extends GenreTag {
  songs: number
  albums: number
  artists: number
  cover_art_ids: string[]
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
  genres?: GenreSummary[]
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

export type TrackListOrder = 'all' | 'random'

export interface TrackPage {
  order: TrackListOrder
  offset: number
  tracks: Track[]
}

export const listTracks = (order: TrackListOrder, offset: number, size: number, signal?: AbortSignal) =>
  apiGet<TrackPage>(`/tracks?${new URLSearchParams({ order, offset: String(offset), size: String(size) })}`, signal)

export const listAlbumsPage = (kind: AlbumListKind, offset: number, size: number, signal?: AbortSignal) =>
  apiGet<AlbumList>(`/albums?${new URLSearchParams({ list: kind, offset: String(offset), size: String(size) })}`, signal)

export const getArtistTracks = (artistId: string, signal?: AbortSignal) =>
  apiGet<{ tracks: Track[] }>(`/artists/${id(artistId)}/tracks`, signal)

// ── Favorites (Navidrome's starred items) ──

export type FavoriteKind = 'track' | 'album' | 'artist'

export interface Favorites {
  tracks: Track[]
  albums: AlbumSummary[]
  artists: ArtistSummary[]
}

export const getFavorites = (signal?: AbortSignal) => apiGet<Favorites>('/favorites', signal)

const FAVORITE_COLLECTION: Record<FavoriteKind, string> = { track: 'tracks', album: 'albums', artist: 'artists' }

export const setFavorite = (kind: FavoriteKind, itemId: string, favorite: boolean) =>
  apiSend(favorite ? 'PUT' : 'DELETE', `/${FAVORITE_COLLECTION[kind]}/${id(itemId)}/favorite`)

// ── Playlists (stored in Navidrome) ──

export interface PlaylistSummary {
  id: string
  name: string
  track_count: number
  duration_seconds: number | null
  cover_art_id: string | null
  owner: string | null
  readonly: boolean
}

export interface Playlist extends PlaylistSummary {
  tracks: Track[]
}

export const listPlaylists = (signal?: AbortSignal) => apiGet<{ playlists: PlaylistSummary[] }>('/playlists', signal)

export const getPlaylist = (playlistId: string, signal?: AbortSignal) =>
  apiGet<Playlist>(`/playlists/${id(playlistId)}`, signal)

export const playlistApi = {
  create: (name: string, trackIds: string[] = []) =>
    apiSend<Playlist>('POST', '/playlists', { name, track_ids: trackIds }),
  rename: (playlistId: string, name: string) => apiSend<Playlist>('PATCH', `/playlists/${id(playlistId)}`, { name }),
  remove: (playlistId: string) => apiSend('DELETE', `/playlists/${id(playlistId)}`),
  addTracks: (playlistId: string, trackIds: string[]) =>
    apiSend<Playlist>('POST', `/playlists/${id(playlistId)}/tracks`, { track_ids: trackIds }),
  removeTrack: (playlistId: string, index: number, trackId: string) =>
    apiSend<Playlist>('DELETE', `/playlists/${id(playlistId)}/tracks/${index}?${new URLSearchParams({ track_id: trackId })}`),
}

/** Artwork sizes the UI asks for. A few fixed sizes keep Navidrome's resize cache warm. */
export type CoverSize = 96 | 300 | 600

export const coverUrl = (coverArtId: string, size: CoverSize) =>
  apiUrl(`/covers/${id(coverArtId)}?size=${size}`)

/** Same-origin audio URL. Navidrome credentials are added server-side. */
export const streamUrl = (trackId: string) => apiUrl(`/tracks/${id(trackId)}/stream`)
