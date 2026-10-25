import { useState } from 'react'
import { type RadioControls, type RadioPreset, presetsApi } from '../api/radio'
import { reloadPresets, usePresets } from '../library/presets'

const CONTROLS: { key: keyof RadioControls; label: string; hint: string }[] = [
  { key: 'familiarity', label: 'Familiarity', hint: 'Favorites and songs you always finish' },
  { key: 'discovery', label: 'Discovery', hint: 'Songs from your library you rarely play' },
  { key: 'continuity', label: 'Continuity', hint: 'Each song flows from the last' },
  { key: 'artist_variety', label: 'Artist variety', hint: 'More artists, fewer repeats' },
  { key: 'genre_variety', label: 'Genre variety', hint: 'Wander beyond the starting style' },
  { key: 'wildcards', label: 'Wildcards', hint: 'The occasional surprise' },
]

const FALLBACK: RadioControls = { familiarity: 50, discovery: 50, continuity: 50, artist_variety: 50, genre_variety: 50, wildcards: 35 }

/**
 * The radio style (preset) editor, shared by Settings › Radio and the
 * station dialog. Saving creates (or, for an existing preset, updates) the
 * preset on the server, refreshes the list, then hands the result back.
 */
export function PresetEditor({ preset, seed, title, context, submitLabel, onSaved, onCancel }: {
  preset: RadioPreset | null
  seed?: { name: string; base: string; controls: Record<string, number> | null } | null
  title: string
  context?: string
  submitLabel: string
  onSaved: (saved: RadioPreset) => void
  onCancel: () => void
}) {
  const { presets } = usePresets()
  const builtins = (presets ?? []).filter((p) => p.kind === 'builtin')
  const startBase = preset?.base_mode ?? seed?.base ?? 'panda'
  const [name, setName] = useState(preset?.name ?? seed?.name ?? '')
  const [base, setBase] = useState(startBase)
  const [controls, setControls] = useState<RadioControls>(
    preset?.controls ?? (seed?.controls as RadioControls | null) ?? builtins.find((b) => b.id === startBase)?.controls ?? FALLBACK,
  )
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
      const body = { name: name.trim(), base_mode: base, controls }
      const saved = preset ? await presetsApi.update(preset.id, body) : await presetsApi.create(body)
      await reloadPresets()
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save the radio style.')
      setBusy(false)
    }
  }

  return (
    <div className="preset-editor">
      <h2 className="modal-title">{title}</h2>
      {context && <p className="hint">{context}</p>}
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
        <button type="button" className="button button--quiet" onClick={onCancel}>Cancel</button>
        <button type="button" className="button" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : submitLabel}</button>
      </div>
    </div>
  )
}
