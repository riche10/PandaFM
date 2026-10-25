// Pure helpers (no API imports), so unit tests can load them directly.

/** Library filters live in the URL (?genre=&decade=&fav=1&lossless=1&hires=1&dl=1) so Back and refresh keep them. */
export interface LibraryFilterState {
  genre: string | null
  decade: number | null
  favorites: boolean
  lossless: boolean
  hires: boolean
  downloaded: boolean
}

export function readFilters(params: URLSearchParams): LibraryFilterState {
  const decade = Number(params.get('decade'))
  return {
    genre: params.get('genre') || null,
    decade: Number.isInteger(decade) && decade >= 1000 && decade % 10 === 0 ? decade : null,
    favorites: params.get('fav') === '1',
    lossless: params.get('lossless') === '1',
    hires: params.get('hires') === '1',
    downloaded: params.get('dl') === '1',
  }
}

export function writeFilters(params: URLSearchParams, f: LibraryFilterState): URLSearchParams {
  const next = new URLSearchParams(params)
  const set = (k: string, v: string | null) => (v ? next.set(k, v) : next.delete(k))
  set('genre', f.genre)
  set('decade', f.decade ? String(f.decade) : null)
  set('fav', f.favorites ? '1' : null)
  set('lossless', f.lossless ? '1' : null)
  set('hires', f.hires ? '1' : null)
  set('dl', f.downloaded ? '1' : null)
  return next
}

export const anyFilter = (f: LibraryFilterState) => !!(f.genre || f.decade || f.favorites || f.lossless || f.hires || f.downloaded)
