import { startRadio } from '../library/play'
import { PRESET_ICONS, presetSubtitle, usePresets } from '../library/presets'
import { useRadio } from '../player'
import { Icon, type IconName } from './Icon'

/** Panda Radio on Home: built-in modes (with your names) and your own presets. */
export function RadioCards() {
  const { presets, error } = usePresets()
  const active = useRadio()
  return (
    <section className="shelf" aria-labelledby="radio-title">
      <div className="shelf-head">
        <h2 id="radio-title" className="section-title">Panda Radio</h2>
      </div>
      {error && <p className="hint">{error}</p>}
      <ul className="shelf-row radio-cards">
        {(presets ?? []).map((p) => {
          const on = active?.presetId === p.id
          return (
            <li key={p.id}>
              <button type="button" className="radio-card" data-active={on ? '' : undefined} aria-pressed={on} onClick={() => void startRadio(p.id, null)}>
                <span className="radio-card-icon" aria-hidden="true">
                  <Icon name={(p.kind === 'builtin' ? PRESET_ICONS[p.id] : 'radio') as IconName} />
                </span>
                {on && <span className="radio-card-live">On air</span>}
                <span>
                  <span className="radio-card-name">{p.name}</span>
                  <span className="radio-card-sub">{presetSubtitle(p)}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
