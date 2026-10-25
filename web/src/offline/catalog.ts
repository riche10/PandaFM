import type { OfflineCollection, OfflineTrack } from './types'

/**
 * What's downloaded, for the Android playback service (5.0.1): local files to play
 * instead of streams, and Android Auto's offline root. Only finished downloads.
 */
export function catalogOf(state: { tracks: Record<string, OfflineTrack>; collections: Record<string, OfflineCollection>; artwork: Record<string, string> }) {
  const tracks = Object.values(state.tracks)
    .filter((t) => (t.status === 'downloaded' || t.status === 'outdated') && t.localUri)
    .map((t) => ({ track: t.track, uri: t.localUri as string }))
  const collections = Object.values(state.collections).map((c) => ({ key: c.key, kind: c.kind, id: c.id, name: c.name, trackIds: c.trackIds, coverArtId: c.coverArtId }))
  return { v: 1, tracks, collections, artwork: state.artwork }
}
