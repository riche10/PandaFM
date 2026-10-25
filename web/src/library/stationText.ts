import type { LibraryGenre, RadioStation } from '../api/radio'

/** "Rock · Pop Punk +1", plus the radio style when it isn't Panda. */
export function stationSubtitle(s: Pick<RadioStation, 'genres' | 'preset' | 'preset_name' | 'preset_missing'>): string {
  const genres = s.genres.slice(0, 2).join(' · ') + (s.genres.length > 2 ? ` +${s.genres.length - 2}` : '')
  if (s.preset_missing) return `${genres} — its radio style was deleted, playing as Panda`
  return s.preset === 'panda' ? genres : `${genres} — ${s.preset_name}`
}

/** The picker's list: matching genres, chosen ones first, then by how many songs you have. */
export function filterGenres(all: LibraryGenre[], query: string, chosen: string[], limit = 60): LibraryGenre[] {
  const q = query.trim().toLowerCase()
  const matches = q ? all.filter((g) => g.name.toLowerCase().includes(q) || (g.family ?? '').includes(q)) : all
  const picked = new Set(chosen)
  return [...matches.filter((g) => picked.has(g.name)), ...matches.filter((g) => !picked.has(g.name))].slice(0, Math.max(limit, picked.size))
}
