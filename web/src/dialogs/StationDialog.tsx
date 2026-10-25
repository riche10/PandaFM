import { useEffect, useState } from 'react'
import { type LibraryGenre, type RadioStation, stationsApi } from '../api/radio'
import { toast } from '../library'
import { usePresets } from '../library/presets'
import { filterGenres, reloadStations } from '../library/stations'
import { closeDialog } from './store'

/** Create or edit a station: a name, the genres it stays in, and its radio style. */
export function StationDialog({ station }: { station: RadioStation | null }) {
  const { presets } = usePresets()
  const [name, setName] = useState(station?.name ?? '')
  const [chosen, setChosen] = useState<string[]>(station?.genres ?? [])
  const [style, setStyle] = useState(station?.preset ?? 'panda')
  const [all, setAll] = useState<LibraryGenre[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    stationsApi.genres().then(setAll, () => setError('PandaFM’s server is needed to pick genres.'))
  }, [])

  const toggle = (genre: string) => setChosen((c) => (c.includes(genre) ? c.filter((g) => g !== genre) : [...c, genre]))
  const save = async () => {
    setBusy(true)
    try {
      const body = { name: name.trim(), genres: chosen, preset: style === 'panda' ? null : style }
      if (station) await stationsApi.update(station.id, body)
      else await stationsApi.create(body)
      await reloadStations()
      toast(station ? `Saved ${body.name}` : `Created the ${body.name} station`)
      closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the station.')
      setBusy(false)
    }
  }

  const shown = all ? filterGenres(all, query, chosen) : []
  return (
    <>
      <h2 className="modal-title">{station ? `Edit ${station.name}` : 'New station'}</h2>
      <p className="hint">A station stays in the music you choose. Its radio style decides how Panda picks inside it.</p>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="field-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Rock" />
      </label>
      <fieldset className="radio-group">
        <legend className="field-label">Genres{chosen.length ? ` (${chosen.length})` : ''}</legend>
        {chosen.length > 0 && (
          <div className="segmented" aria-label="Chosen genres">
            {chosen.map((g) => (
              <button key={g} type="button" className="chip" aria-pressed="true" onClick={() => toggle(g)} aria-label={`Remove ${g}`}>{g} ✕</button>
            ))}
          </div>
        )}
        <input className="field-input genre-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your genres" aria-label="Search your genres" />
        <div className="genre-list" role="group" aria-label="Genres in your library">
          {all === null && !error && <p className="hint">Loading your genres…</p>}
          {shown.map((g) => (
            <label key={g.name} className="check-option genre-option">
              <input type="checkbox" checked={chosen.includes(g.name)} onChange={() => toggle(g.name)} />
              <span className="genre-name">{g.name}</span>
              <span className="genre-count">{g.songs}</span>
            </label>
          ))}
          {all !== null && shown.length === 0 && <p className="hint">No genres match “{query}”.</p>}
        </div>
      </fieldset>
      <label className="field">
        <span className="field-label">Radio style</span>
        <select className="field-input" value={style} onChange={(e) => setStyle(e.target.value)}>
          {(presets ?? [{ id: 'panda', name: 'Panda Radio' }]).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button button--quiet" onClick={closeDialog}>Cancel</button>
        <button type="button" className="button" disabled={busy || !name.trim() || chosen.length === 0} onClick={() => void save()}>
          {busy ? 'Saving…' : station ? 'Save' : 'Create station'}
        </button>
      </div>
    </>
  )
}
