import { useMemo, useRef, useState } from 'react'
import { contrast, isHex } from '../../appearance/color'
import { checkCustomTheme, CUSTOM_FIELDS, type CustomField, type CustomTheme, customTokens, exportTheme, importTheme } from '../../appearance/resolve'
import { resetAppearance, setAppearance, useAppearance } from '../../appearance/store'
import { ACCENTS, BUILT_IN_THEMES, THEMES } from '../../appearance/themes'
import { toast } from '../../library'

const FIELD_LABELS: Record<CustomField, string> = {
  background: 'Background', surface: 'Surface', textPrimary: 'Primary text', textSecondary: 'Secondary text', accent: 'Accent', border: 'Border',
}

const TOKEN_OF: Record<CustomField, string> = {
  background: 'background', surface: 'surface', textPrimary: 'text-primary', textSecondary: 'text-secondary', accent: 'accent', border: 'border',
}

function Swatch({ colors }: { colors: string[] }) {
  return (
    <span className="theme-swatch" aria-hidden="true">
      {colors.map((c, i) => <span key={i} style={{ background: c }} />)}
    </span>
  )
}

/** Theme, artwork colours, accent and a safe custom theme. All kept on this device. */
export function AppearanceSettings() {
  const a = useAppearance()
  const options = [
    { id: 'system', label: 'System', colors: [THEMES.light.tokens.background, THEMES.dark.tokens.background, THEMES.dark.tokens.accent] },
    ...BUILT_IN_THEMES.map((t) => ({ id: t.id, label: t.label, colors: [t.tokens.background, t.tokens.surface, t.tokens.accent] })),
    ...(a.custom ? [{ id: 'custom', label: a.custom.name, colors: (() => { const t = customTokens(a.custom!); return [t.background, t.surface, t.accent] })() }] : []),
  ]
  return (
    <section className="settings-block" id="appearance" aria-labelledby="appearance-title">
      <h2 className="section-title" id="appearance-title">Appearance</h2>
      <p className="hint">Each device keeps its own look: AMOLED on the Walkman, Light on the desktop.</p>

      <span className="field-label">Theme</span>
      <div className="theme-grid" role="group" aria-label="Theme">
        {options.map((o) => (
          <button key={o.id} type="button" className="theme-option" aria-pressed={a.theme === o.id} onClick={() => setAppearance({ theme: o.id })}>
            <Swatch colors={o.colors} />
            <span className="theme-name">{o.label}</span>
          </button>
        ))}
      </div>

      <span className="field-label">Artwork colors</span>
      <div className="segmented" role="group" aria-label="Artwork colors">
        {(['off', 'subtle', 'immersive'] as const).map((m) => (
          <button key={m} type="button" className="chip" aria-pressed={a.artwork === m} onClick={() => setAppearance({ artwork: m })}>
            {m === 'off' ? 'Off' : m === 'subtle' ? 'Subtle' : 'Immersive'}
          </button>
        ))}
      </div>
      <p className="hint">
        {a.artwork === 'off' ? 'The theme’s own colours everywhere.' : a.artwork === 'subtle' ? 'Album art tints headers, Now Playing and the player.' : 'Album art colours the music screens and their accent.'}
      </p>

      <span className="field-label">Accent</span>
      <div className="accent-row" role="group" aria-label="Accent">
        {ACCENTS.map((x) => {
          const color = x.id === 'theme' ? (THEMES[a.theme]?.tokens.accent ?? THEMES['panda-classic'].tokens.accent) : x.id === 'custom' ? a.customAccent : x.color!
          return (
            <button key={x.id} type="button" className="accent-dot" style={{ background: color }} aria-pressed={a.accent === x.id} aria-label={x.label} title={x.label}
              onClick={() => setAppearance({ accent: x.id })} />
          )
        })}
        {a.accent === 'custom' && (
          <input type="color" aria-label="Custom accent" value={a.customAccent} onChange={(e) => isHex(e.target.value) && setAppearance({ customAccent: e.target.value })} />
        )}
      </div>

      <CustomThemeEditor />

      <button type="button" className="button button--quiet" onClick={() => { resetAppearance(); toast('Back to Panda Classic') }}>
        Reset to Panda Classic
      </button>
    </section>
  )
}

function CustomThemeEditor() {
  const a = useAppearance()
  const [draft, setDraft] = useState<CustomTheme>(a.custom ?? { name: 'My theme', base: 'dark', tokens: {}, corners: 'rounded' })
  const [json, setJson] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const check = useMemo(() => checkCustomTheme(draft), [draft])
  const tokens = customTokens(draft)

  const set = (field: CustomField, value: string) => setDraft({ ...draft, tokens: { ...draft.tokens, [field]: value } })
  const use = () => {
    if (!check.ok || !check.theme) return
    setAppearance({ custom: check.theme, theme: 'custom' })
    toast(`Using ${check.theme.name}`)
  }
  const load = (text: string) => {
    const result = importTheme(text)
    if (!result.ok || !result.theme) return toast(result.errors[0] ?? 'That theme couldn’t be imported.', 'error')
    setDraft(result.theme)
    toast(`Imported ${result.theme.name}${result.warnings.length ? ' (some settings were ignored)' : ''}`)
  }

  return (
    <details className="custom-theme">
      <summary className="field-label">Custom theme</summary>
      <div className="editor-grid">
        <label className="field">
          <span className="field-label">Name</span>
          <input className="field-input" value={draft.name} maxLength={40} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Start from</span>
          <select className="field-input" value={draft.base} onChange={(e) => setDraft({ ...draft, base: e.target.value })}>
            {BUILT_IN_THEMES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        {CUSTOM_FIELDS.map((f) => (
          <label key={f} className="color-field">
            <span>{FIELD_LABELS[f]}</span>
            <input type="color" value={draft.tokens[f] ?? tokens[TOKEN_OF[f] as keyof typeof tokens]} onChange={(e) => set(f, e.target.value)} />
          </label>
        ))}
        <span className="field-label">Corners</span>
        <div className="segmented" role="group" aria-label="Corners">
          {(['sharp', 'rounded', 'soft'] as const).map((c) => (
            <button key={c} type="button" className="chip" aria-pressed={draft.corners === c} onClick={() => setDraft({ ...draft, corners: c })}>
              {c[0].toUpperCase() + c.slice(1)}
            </button>
          ))}
        </div>
        <p className="hint">Text contrast: {contrast(tokens['text-primary'], tokens.background).toFixed(1)} : 1</p>
        {check.errors.map((e) => <p key={e} className="field-error">{e}</p>)}
        {check.warnings.map((w) => <p key={w} className="field-warning">{w}</p>)}
        <div className="offline-actions">
          <button type="button" className="button" disabled={!check.ok} onClick={use}>Use this theme</button>
          <button type="button" className="button button--quiet" onClick={() => setDraft({ ...draft, tokens: {}, corners: 'rounded' })}>Reset theme</button>
          <button type="button" className="button button--quiet" onClick={() => check.theme && setJson(exportTheme(check.theme))} disabled={!check.ok}>Export</button>
          <button type="button" className="button button--quiet" onClick={() => file.current?.click()}>Import file</button>
          <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => void e.target.files?.[0]?.text().then(load)} />
        </div>
        <label className="field">
          <span className="field-label">Theme file (JSON: colours only)</span>
          <textarea className="theme-json" value={json} onChange={(e) => setJson(e.target.value)} placeholder='{"format": 1, "name": "…", "base": "dark", "tokens": {…}}' spellCheck={false} />
        </label>
        <div className="offline-actions">
          <button type="button" className="button button--quiet" disabled={!json.trim()} onClick={() => load(json)}>Import from text</button>
          <button type="button" className="button button--quiet" disabled={!json.trim()} onClick={() => void navigator.clipboard?.writeText(json).then(() => toast('Copied'))}>Copy</button>
        </div>
      </div>
    </details>
  )
}
