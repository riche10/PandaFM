import type { Manifest, ManifestItem, OfflineTrack } from './types'
import { playable } from './types.ts'

// Pure decisions for downloading and syncing a collection. One copy of a
// song is shared by every collection that contains it (reference counting),
// so removing one playlist never deletes a song another download still needs.

export interface CollectionPlan {
  download: ManifestItem[] // not on the device yet (or failed before)
  refresh: ManifestItem[] // on the device, but the library file changed since
  link: string[] // already on (or on the way to) the device: just add this collection's reference
  unref: string[] // no longer in the collection
}

export function planCollection(previous: string[], manifest: Manifest, local: Map<string, OfflineTrack>): CollectionPlan {
  const result: CollectionPlan = { download: [], refresh: [], link: [], unref: [] }
  const now = new Set(manifest.items.map((i) => i.track.id))
  for (const item of manifest.items) {
    const entry = local.get(item.track.id)
    if (!entry || entry.status === 'failed') {
      result.download.push(item)
      continue
    }
    result.link.push(item.track.id)
    if (playable(entry) && item.source_revision && entry.sourceRevision && item.source_revision !== entry.sourceRevision) {
      result.refresh.push(item)
    }
  }
  result.unref = previous.filter((id) => !now.has(id))
  return result
}

/** Drop a collection's reference from songs; those nobody references any more are orphans to delete. */
export function release(local: Map<string, OfflineTrack>, key: string, trackIds: string[]): { updated: OfflineTrack[]; orphans: OfflineTrack[] } {
  const updated: OfflineTrack[] = []
  const orphans: OfflineTrack[] = []
  for (const id of trackIds) {
    const entry = local.get(id)
    if (!entry || !entry.refs.includes(key)) continue
    const next = { ...entry, refs: entry.refs.filter((r) => r !== key) }
    if (next.refs.length === 0) orphans.push(next)
    else updated.push(next)
  }
  return { updated, orphans }
}
