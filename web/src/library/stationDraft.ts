// The New/Edit Station form as plain data, so creating a radio style inline
// (a child view of the same dialog) can never lose the station being built.
// Pure: unit-tested without React.

export interface StyleSeed {
  name: string
  base: string // built-in mode to start from
  controls: Record<string, number> | null // null: the base mode's own settings
}

export interface StationDraft {
  name: string
  genres: string[] // WHAT the station plays (never part of a style)
  style: string // HOW it chooses: a built-in mode id or a custom preset id
  query: string // genre search text
  view: 'station' | 'style' // the style editor is a child view of the same dialog
  styleSeed: StyleSeed | null
}

export type DraftAction =
  | { type: 'name'; value: string }
  | { type: 'toggleGenre'; genre: string }
  | { type: 'query'; value: string }
  | { type: 'style'; id: string }
  | { type: 'newStyle' }
  | { type: 'customizeStyle'; from: { name: string; base_mode: string; controls: Record<string, number> } }
  | { type: 'styleSaved'; id: string }
  | { type: 'styleCancelled' }

export function initialDraft(station: { name: string; genres: string[]; preset: string } | null, prefill?: { name: string; genres: string[] }): StationDraft {
  return {
    name: station?.name ?? prefill?.name ?? '',
    genres: station?.genres ?? prefill?.genres ?? [],
    style: station?.preset ?? 'panda', // the default, shown as "Panda Radio" rather than hidden
    query: '',
    view: 'station',
    styleSeed: null,
  }
}

export function draftReducer(d: StationDraft, a: DraftAction): StationDraft {
  switch (a.type) {
    case 'name':
      return { ...d, name: a.value }
    case 'toggleGenre':
      return { ...d, genres: d.genres.includes(a.genre) ? d.genres.filter((g) => g !== a.genre) : [...d.genres, a.genre] }
    case 'query':
      return { ...d, query: a.value }
    case 'style':
      return { ...d, style: a.id }
    case 'newStyle':
      return { ...d, view: 'style', styleSeed: { name: '', base: 'panda', controls: null } }
    case 'customizeStyle': // a new custom copy; the original (built-in or not) is never changed
      return { ...d, view: 'style', styleSeed: { name: `${a.from.name} copy`.slice(0, 40), base: a.from.base_mode, controls: { ...a.from.controls } } }
    case 'styleSaved':
      return { ...d, view: 'station', styleSeed: null, style: a.id }
    case 'styleCancelled':
      return { ...d, view: 'station', styleSeed: null }
  }
}

/** What the station API receives: the genres (WHAT) and a reference to a style (HOW). */
export function stationPayload(d: StationDraft): { name: string; genres: string[]; preset: string | null } {
  return { name: d.name.trim(), genres: [...d.genres], preset: d.style === 'panda' ? null : d.style }
}
