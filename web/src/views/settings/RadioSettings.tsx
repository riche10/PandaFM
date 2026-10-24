import { useState } from 'react'
import { presetsApi, type RadioPreset } from '../../api/radio'
import { Icon } from '../../components/Icon'
import { openDialog } from '../../dialogs/store'
import { toast } from '../../library'
import { presetSubtitle, reloadPresets, usePresets } from '../../library/presets'

/** Built-in mode names and your own Panda Radio presets (shared by all your devices). */
export function RadioSettings() {
  const { presets, error } = usePresets()
  const builtins = (presets ?? []).filter((p) => p.kind === 'builtin')
  const custom = (presets ?? []).filter((p) => p.kind === 'custom')
  const act = async (work: () => Promise<unknown>, message: string) => {
    try {
      await work()
      await reloadPresets()
      toast(message)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That didn’t work.', 'error')
    }
  }
  return (
    <section className="settings-block" id="radio" aria-labelledby="radio-settings-title">
      <h2 className="section-title" id="radio-settings-title">Panda Radio</h2>
      {error && <p className="field-error">{error}</p>}
      <span className="field-label">Built-in mode names</span>
      <p className="hint">Rename how a mode appears. How it chooses songs stays the same.</p>
      {builtins.map((p) => <ModeName key={p.id} preset={p} onSave={(name) => act(() => presetsApi.rename(p.id, name), name ? `Renamed to ${name}` : `Back to ${p.default_name}`)} />)}

      <span className="field-label">Your presets</span>
      {custom.length === 0 && <p className="hint">Create your own mode, like Night Drive or Deep Work, starting from any built-in.</p>}
      <ul className="offline-list">
        {[...custom, ...builtins].map((p) => (
          <li key={p.id} className="preset-row">
            <span className="preset-row-text">
              <span className="preset-row-name">{p.name}</span>
              <span className="preset-row-sub">{p.kind === 'builtin' ? 'Built-in' : presetSubtitle(p)}</span>
            </span>
            {p.kind === 'custom' && (
              <button type="button" className="text-button" onClick={() => openDialog({ type: 'preset', preset: p })}>Edit</button>
            )}
            <button type="button" className="text-button" onClick={() => void act(() => presetsApi.duplicate(p.id), `Duplicated ${p.name}`)}>Duplicate</button>
            {p.kind === 'custom' && (
              <button type="button" className="icon-button" aria-label={`Delete ${p.name}`}
                onClick={() => window.confirm(`Delete ${p.name}? Your listening history is kept.`) && void act(() => presetsApi.remove(p.id), `Deleted ${p.name}`)}>
                <Icon name="trash" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" className="button" onClick={() => openDialog({ type: 'preset', preset: null })}>+ New radio preset</button>
    </section>
  )
}

function ModeName({ preset, onSave }: { preset: RadioPreset; onSave: (name: string | null) => void }) {
  const [name, setName] = useState(preset.name)
  const renamed = preset.name !== preset.default_name
  return (
    <div className="name-row">
      <label className="field">
        <span className="field-label">{preset.default_name}</span>
        <input className="field-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== preset.name && onSave(name.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      </label>
      {renamed ? (
        <button type="button" className="text-button" onClick={() => { setName(preset.default_name ?? ''); onSave(null) }}>Reset name</button>
      ) : <span />}
    </div>
  )
}
