// Multi-select (5.3): which rows of a list are selected. Pure, keyed by position
// (a playlist can hold the same song twice), so it's unit-tested.

export interface Selection {
  picked: ReadonlySet<number>
  /** Where a Shift-click range starts. */
  anchor: number | null
}

export const empty: Selection = { picked: new Set(), anchor: null }

export function toggle(s: Selection, index: number): Selection {
  const picked = new Set(s.picked)
  if (picked.has(index)) picked.delete(index)
  else picked.add(index)
  return { picked, anchor: index }
}

/** Shift-click: everything between the anchor and here becomes selected. */
export function extend(s: Selection, index: number): Selection {
  if (s.anchor === null) return toggle(s, index)
  const picked = new Set(s.picked)
  const [from, to] = s.anchor < index ? [s.anchor, index] : [index, s.anchor]
  for (let i = from; i <= to; i++) picked.add(i)
  return { picked, anchor: s.anchor }
}

export function all(count: number): Selection {
  return { picked: new Set(Array.from({ length: count }, (_, i) => i)), anchor: null }
}

/** The selected items, in list order. */
export function pick<T>(s: Selection, items: readonly T[]): T[] {
  return [...s.picked].filter((i) => i < items.length).sort((a, b) => a - b).map((i) => items[i])
}

/** Positions highest-first: removing them one by one keeps the remaining positions valid. */
export function descending(s: Selection): number[] {
  return [...s.picked].sort((a, b) => b - a)
}
