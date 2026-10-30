/**
 * 5.5.2: removing several rows from a playlist, from either view. Navidrome removes by position in the
 * playlist itself, so positions go highest first (the rest stay valid). When the rows were picked in the
 * Panda Mix order, each also removes its position in the saved mixed order: those shift as earlier ones go,
 * so each is adjusted by how many lower mixed positions were already removed.
 */
export interface Removal {
  index: number
  trackId: string
  mixIndex?: number
}

export function removalPlan(selected: number[], trackIds: string[], playlistIndexes?: number[], mixed = false): Removal[] {
  const rows = selected.map((row) => ({ index: playlistIndexes?.[row] ?? row, trackId: trackIds[row], mix: mixed ? row : undefined }))
  rows.sort((a, b) => b.index - a.index)
  const removedMix: number[] = []
  return rows.map(({ index, trackId, mix }) => {
    if (mix === undefined) return { index, trackId }
    const mixIndex = mix - removedMix.filter((m) => m < mix).length
    removedMix.push(mix)
    return { index, trackId, mixIndex }
  })
}
