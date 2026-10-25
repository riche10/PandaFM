import { useState } from 'react'
import { exploreApi, type LibraryFilterState } from '../api/explore'
import { useApi } from '../hooks/useApi'
import { isNative } from '../platform/state'
import { closeDialog } from './store'

/** Library filters as a sheet: genre, decade and a few toggles. Applying updates the URL. */
export function FiltersDialog({ kind, value, onApply }: { kind: 'albums' | 'songs'; value: LibraryFilterState; onApply: (f: LibraryFilterState) => void }) {
  const [f, setF] = useState(value)
  const [genres] = useApi('explore:genres:name', (signal) => exploreApi.genres('name', signal))
  const [decades] = useApi('explore:decades', (signal) => exploreApi.decades(signal))
  const toggle = (key: 'favorites' | 'lossless' | 'hires' | 'downloaded', label: string) => (
    <label className="check-option">
      <input type="checkbox" checked={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.checked })} />
      {label}
    </label>
  )
  return (
    <>
      <h2 className="modal-title">Filter {kind}</h2>
      <label className="field">
        <span className="field-label">Genre</span>
        <select className="field-input" value={f.genre ?? ''} onChange={(e) => setF({ ...f, genre: e.target.value || null })}>
          <option value="">Any genre</option>
          {genres.state === 'ready' && genres.data.map((g) => <option key={g.key} value={g.key}>{g.name} ({g.songs})</option>)}
        </select>
      </label>
      <label className="field">
        <span className="field-label">Decade</span>
        <select className="field-input" value={f.decade ?? ''} onChange={(e) => setF({ ...f, decade: e.target.value ? Number(e.target.value) : null })}>
          <option value="">Any decade</option>
          {decades.state === 'ready' && decades.data.map((d) => <option key={d.decade} value={d.decade}>{d.label}</option>)}
        </select>
      </label>
      {toggle('favorites', kind === 'albums' ? 'Favorite albums' : 'Favorite songs')}
      {kind === 'songs' && toggle('lossless', 'Lossless')}
      {kind === 'songs' && toggle('hires', 'Hi-Res')}
      {kind === 'songs' && isNative() && toggle('downloaded', 'Downloaded on this device')}
      <div className="modal-actions">
        <button type="button" className="button button--quiet" onClick={() => setF({ genre: null, decade: null, favorites: false, lossless: false, hires: false, downloaded: false })}>Clear</button>
        <button type="button" className="button" onClick={() => { onApply(f); closeDialog() }}>Show {kind}</button>
      </div>
    </>
  )
}
