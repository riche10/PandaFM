import { useEffect, useReducer, useState } from 'react'
import { type LibraryGenre, type RadioStation, stationsApi } from '../api/radio'
import { useBackLayer } from '../hooks/useBackLayer'
import { toast } from '../library'
import { usePresets } from '../library/presets'
import { draftReducer, initialDraft, stationPayload } from '../library/stationDraft'
import { filterGenres, reloadStations } from '../library/stations'
import { PresetEditor } from './PresetEditor'
import { closeDialog } from './store'

/**
 * Create or edit a station: a name, the genres it stays in (WHAT), and its
 * radio style (HOW). A new style can be made right here: the dialog swaps to
 * the style editor and back, keeping everything already filled in.
 */
export function StationDialog({ station, prefill }: { station: RadioStation | null; prefill?: { name: string; genres: string[] } }) {
  const { presets } = usePresets()
  const [draft, dispatch] = useReducer(draftReducer, null, () => initialDraft(station, prefill))
  const [all, setAll] = useState<LibraryGenre[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inStyleEditor = draft.view === 'style'

  // Android Back in the style editor returns to the unfinished station (the dialog's own layer closes it after that).
  useBackLayer(inStyleEditor, () => dispatch({ type: 'styleCancelled' }))

  useEffect(() => {
    stationsApi.genres().then(setAll, () => setError('PandaFM’s server is needed to pick genres.'))
  }, [])

  const save = async () => {
    setBusy(true)
    try {
      const body = stationPayload(draft)
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

  if (inStyleEditor) {
    return (
      // Esc here goes back to the station rather than closing the whole dialog.
      <div onKeyDownCapture={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dispatch({ type: 'styleCancelled' }) } }}>
        <PresetEditor
          preset={null}
          seed={draft.styleSeed}
          title="New radio style"
          context={`For the station${draft.name.trim() ? ` “${draft.name.trim()}”` : ''}. You can use this style for other stations too.`}
          submitLabel="Save & use this style"
          onSaved={(saved) => {
            dispatch({ type: 'styleSaved', id: saved.id })
            toast(`Created ${saved.name}`)
          }}
          onCancel={() => dispatch({ type: 'styleCancelled' })}
        />
      </div>
    )
  }

  const options = presets ?? [{ id: 'panda', name: 'Panda Radio', kind: 'builtin' as const, base_mode: 'panda', controls: null }]
  const selected = (presets ?? []).find((p) => p.id === draft.style)
  const shown = all ? filterGenres(all, draft.query, draft.genres) : []
  return (
    <>
      <h2 className="modal-title">{station ? `Edit ${station.name}` : 'New station'}</h2>
      <p className="hint">A station stays in the music you choose. Its radio style decides how Panda picks inside it.</p>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="field-input" value={draft.name} maxLength={40} onChange={(e) => dispatch({ type: 'name', value: e.target.value })} placeholder="Rock" />
      </label>
      <fieldset className="radio-group">
        <legend className="field-label">Genres{draft.genres.length ? ` (${draft.genres.length})` : ''}</legend>
        {draft.genres.length > 0 && (
          <div className="segmented" aria-label="Chosen genres">
            {draft.genres.map((g) => (
              <button key={g} type="button" className="chip" aria-pressed="true" onClick={() => dispatch({ type: 'toggleGenre', genre: g })} aria-label={`Remove ${g}`}>{g} ✕</button>
            ))}
          </div>
        )}
        <input className="field-input genre-search" type="search" value={draft.query} onChange={(e) => dispatch({ type: 'query', value: e.target.value })} placeholder="Search your genres" aria-label="Search your genres" />
        <div className="genre-list" role="group" aria-label="Genres in your library">
          {all === null && !error && <p className="hint">Loading your genres…</p>}
          {shown.map((g) => (
            <label key={g.name} className="check-option genre-option">
              <input type="checkbox" checked={draft.genres.includes(g.name)} onChange={() => dispatch({ type: 'toggleGenre', genre: g.name })} />
              <span className="genre-name">{g.name}</span>
              <span className="genre-count">{g.songs}</span>
            </label>
          ))}
          {all !== null && shown.length === 0 && <p className="hint">No genres match “{draft.query}”.</p>}
        </div>
      </fieldset>
      <label className="field">
        <span className="field-label">Radio style</span>
        <select className="field-input" value={draft.style} onChange={(e) => dispatch({ type: 'style', id: e.target.value })}>
          {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <p className="hint">Radio style controls how familiar, adventurous, continuous and varied this station will be. It doesn’t change the station’s genres.</p>
      <div className="style-actions">
        <button type="button" className="text-button" onClick={() => dispatch({ type: 'newStyle' })}>+ Create new radio style</button>
        {selected && (
          <button type="button" className="text-button" onClick={() => dispatch({ type: 'customizeStyle', from: { name: selected.name, base_mode: selected.base_mode, controls: { ...selected.controls } } })}>Customize a copy</button>
        )}
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button button--quiet" onClick={closeDialog}>Cancel</button>
        <button type="button" className="button" disabled={busy || !draft.name.trim() || draft.genres.length === 0} onClick={() => void save()}>
          {busy ? 'Saving…' : station ? 'Save' : 'Create station'}
        </button>
      </div>
    </>
  )
}
