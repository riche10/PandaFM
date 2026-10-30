import type { Track } from '../api/library.ts'

/**
 * 5.5.2: the playlist in mixed order, each row with its position in the playlist itself. Duplicates are
 * separate occurrences: the k-th "A" in the mixed order is the k-th "A" in the playlist (the same rule the
 * server keeps), so removing a row removes that exact occurrence.
 */
export function mixEntries(tracks: Track[], order: string[] | undefined): { track: Track; index: number }[] {
  if (!order?.length) return tracks.map((track, index) => ({ track, index }))
  const positions = new Map<string, number[]>()
  tracks.forEach((t, i) => positions.set(t.id, [...(positions.get(t.id) ?? []), i]))
  const used = new Set<number>()
  const out: { track: Track; index: number }[] = []
  for (const id of order) {
    const i = positions.get(id)?.shift()
    if (i !== undefined) {
      used.add(i)
      out.push({ track: tracks[i], index: i })
    }
  }
  tracks.forEach((track, index) => {
    if (!used.has(index)) out.push({ track, index })
  })
  return out
}

export function inMixOrder(tracks: Track[], order: string[] | undefined): Track[] {
  return mixEntries(tracks, order).map((e) => e.track)
}
