import { useState } from 'react'
import { type RadioControls, type RadioPreset, presetsApi } from '../api/radio'
import { toast } from '../library'
import { reloadPresets, usePresets } from '../library/presets'
import { closeDialog } from './store'

const CONTROLS: { key: keyof RadioControls; label: string; hint: string }[] = [
  { key: 'familiarity', label: 'Familiarity', hint: 'Favorites and songs you always finish' },
  { key: 'discovery', label: 'Discovery', hint: 'Songs from your library you rarely play' },
  { key: 'continuity', label: 'Continuity', hint: 'Each song flows from the last' },
  { key: 'artist_variety', label: 'Artist variety', hint: 'More artists, fewer repeats' },
  { key: 'genre_variety', label: 'Genre variety', hint: 'Wander beyond the starting style' },
  { key: 'wildcards', label: 'Wildcards', hint: 'The occasional surprise' },
]

/** Create or edit a Panda Radio preset. The server turns these into safe, bounded weights. */
export function PresetDialog({ preset }: { preset: RadioPreset | null }) {
  const { presets } = usePresets()
  const builtins = (presets ?? []).filter((p) => p.kind === 'builtin')
  const [name, setName] = useState(preset?.name ?? '')
  const [base, setBase] = useState(preset?.base_mode ?? 'panda')
  const [controls, setControls] = useState<RadioControls>(preset?.controls ?? builtins.find((b) => b.id === 'panda')?.controls ?? {
    familiarity: 50, discovery: 50, continuity: 50, artist_variety: 50, genre_variety: 50, wildcards: 35,
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const startFrom = (id: string) => {
    setBase(id)
    const b = builtins.find((x) => x.id === id)
    if (b) setControls(b.controls) // start from that mode's own behaviour
  }

  const save = async () => {
    setBusy(true)
    try {
      if (preset) await presetsApi.update(preset.id, { name: name.trim(), base_mode: base, controls })
      else await presetsApi.create({ name: name.trim(), base_mode: base, controls })
      await reloadPresets()
      toast(preset ? `Saved ${name.trim()}` : `Created ${name.trim()}`)
      closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the preset.')
      setBusy(false)
    }
  }

  return (
    <>
      <h2 className="modal-title">{preset ? `Edit ${preset.name}` : 'New radio preset'}</h2>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="field-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Night Drive" />
      </label>
      <fieldset className="radio-group">
        <legend className="field-label">Start from</legend>
        <div className="segmented">
          {builtins.map((b) => (
            <button key={b.id} type="button" className="chip" aria-pressed={base === b.id} onClick={() => startFrom(b.id)}>{b.name}</button>
          ))}
        </div>
      </fieldset>
      <div>
        {CONTROLS.map((c) => (
          <label key={c.key} className="control-slider">
            <span className="control-slider-head">
              <span>{c.label}</span>
              <span>{controls[c.key]}%</span>
            </span>
            <input type="range" min={0} max={100} step={5} value={controls[c.key]} onChange={(e) => setControls({ ...controls, [c.key]: Number(e.target.value) })} />
            <span className="control-slider-hint">{c.hint}</span>
          </label>
        ))}
      </div>
      <p className="hint">Repeat protection and your library’s availability always apply.</p>
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button button--quiet" onClick={closeDialog}>Cancel</button>
        <button type="button" className="button" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </>
  )
}
