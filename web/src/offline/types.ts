import type { Track } from '../api/library'

/** One song on this device (or on its way there). */
export interface OfflineTrack {
  trackId: string // Navidrome id: the identity, never the file name
  track: Track // snapshot for browsing and playing offline
  profile: string
  relativePath: string
  localUri: string | null // content:// inside the chosen folder, once downloaded
  sizeBytes: number | null
  sha256: string | null
  sourceRevision: string | null
  codec: string
  lossless: boolean | null
  qualityBadge: string | null
  qualityDetail: string | null
  bitrateKbps: number | null
  status: 'queued' | 'downloading' | 'downloaded' | 'failed' | 'outdated'
  attempts: number
  error: string | null
  downloadedAt: string | null
  /** Collections holding this song ("album:ID", "playlist:ID", "favorites", "track:ID"). */
  refs: string[]
}

export type CollectionKind = 'track' | 'album' | 'playlist' | 'favorites'

/** A downloaded song, album, playlist or Favorites, with its membership snapshot. */
export interface OfflineCollection {
  key: string
  kind: CollectionKind
  id: string | null
  name: string
  profile: string
  keepSynced: boolean
  trackIds: string[]
  coverArtId: string | null
  durationSeconds: number
  updatedAt: string
}

export interface ManifestItem {
  track: Track
  plan: { profile: string; action: 'original' | 'convert'; extension: string; codec: string; lossless: boolean | null; bitrate_kbps: number | null; estimated_bytes: number | null; exact_size: boolean; note: string | null }
  relative_path: string
  url: string
  source_revision: string | null
  size_bytes: number | null
  sha256: string | null
  status: 'ready' | 'pending'
}

export interface Manifest {
  kind: string
  id: string | null
  name: string
  profile: string
  duration_seconds: number
  items: ManifestItem[]
  estimates: { profile: string; label: string; bytes: number; exact: boolean }[]
}

export const collectionKey = (kind: CollectionKind, id: string | null) => (kind === 'favorites' ? 'favorites' : `${kind}:${id}`)

export const playable = (t: OfflineTrack | undefined) => !!t?.localUri && (t.status === 'downloaded' || t.status === 'outdated')
