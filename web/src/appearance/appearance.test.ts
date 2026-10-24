import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyResolved } from './apply.ts'
import { artworkTint, contrast } from './color.ts'
import { checkCustomTheme, DEFAULT_APPEARANCE, exportTheme, importTheme, resolveAppearance } from './resolve.ts'
import { loadAppearance, saveAppearance } from './store.ts'
import { BUILT_IN_THEMES, TOKENS } from './themes.ts'

const memory = (initial: Record<string, string> = {}) => {
  const data = { ...initial }
  return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => { data[k] = v }, data }
}

describe('themes', () => {
  it('every built-in theme defines every token, with readable text and controls', () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const token of TOKENS) assert.ok(theme.tokens[token], `${theme.id} ${token}`)
      const t = theme.tokens
      assert.ok(contrast(t['text-primary'], t.background) >= 7, `${theme.id} text`)
      assert.ok(contrast(t['text-secondary'], t.background) >= 4.5, `${theme.id} secondary`)
      assert.ok(contrast(t['text-muted'], t.background) >= 3, `${theme.id} muted`)
      assert.ok(contrast(t['accent-contrast'], t.accent) >= 4.5, `${theme.id} accent icon`)
      assert.ok(contrast(t.border, t.background) > 1.15, `${theme.id} borders stay visible`)
    }
  })

  it('maps System to Light or Dark, and keeps AMOLED truly black', () => {
    assert.equal(resolveAppearance({ ...DEFAULT_APPEARANCE, theme: 'system' }, true).themeId, 'dark')
    assert.equal(resolveAppearance({ ...DEFAULT_APPEARANCE, theme: 'system' }, false).scheme, 'light')
    assert.equal(resolveAppearance({ ...DEFAULT_APPEARANCE, theme: 'amoled' }, false).tokens.background, '#000000')
    const light = resolveAppearance({ ...DEFAULT_APPEARANCE, theme: 'light' }, true)
    assert.notEqual(light.tokens.background, '#ffffff') // warm paper, not office white
  })

  it('unknown themes and broken custom themes fall back to Panda Classic', () => {
    assert.equal(resolveAppearance({ ...DEFAULT_APPEARANCE, theme: 'neon-nightmare' }, true).themeId, 'panda-classic')
    const broken = { ...DEFAULT_APPEARANCE, theme: 'custom', custom: { name: 'x', base: 'dark', tokens: { background: 'url(evil)' }, corners: 'rounded' as const } }
    assert.equal(resolveAppearance(broken as never, true).themeId, 'panda-classic')
  })

  it('a chosen accent is kept visible and gets a readable foreground', () => {
    const r = resolveAppearance({ ...DEFAULT_APPEARANCE, theme: 'light', accent: 'amber' }, false)
    assert.ok(contrast(r.tokens.accent, r.tokens.background) >= 3)
    assert.ok(contrast(r.tokens['accent-contrast'], r.tokens.accent) >= 4.5)
    const custom = resolveAppearance({ ...DEFAULT_APPEARANCE, accent: 'custom', customAccent: '#00ff00' }, true)
    assert.ok(custom.tokens.accent.startsWith('#'))
  })

  it('artwork colours stay readable with the theme text, Off/Subtle/Immersive pass through', () => {
    for (const raw of ['#ffee00', '#101010', '#ff0000', '#ffffff', '#3355ff']) {
      const dark = artworkTint(raw, 'dark', '#f4efe6')
      const light = artworkTint(raw, 'light', '#23201c')
      assert.ok(contrast(dark, '#f4efe6') >= 4.5, `dark ${raw}`)
      assert.ok(contrast(light, '#23201c') >= 4.5, `light ${raw}`)
    }
    for (const artwork of ['off', 'subtle', 'immersive'] as const) {
      assert.equal(resolveAppearance({ ...DEFAULT_APPEARANCE, artwork }, true).artwork, artwork)
    }
  })

  it('applies tokens as CSS variables without touching anything else', () => {
    const set: Record<string, string> = {}
    const target = { style: { setProperty: (k: string, v: string) => { set[k] = v } }, dataset: {} as Record<string, string> }
    applyResolved(target, resolveAppearance({ ...DEFAULT_APPEARANCE, theme: 'walkman-midnight', artwork: 'immersive' }, true))
    assert.equal(set['--background'], '#07090d')
    assert.equal(set['color-scheme'], 'dark')
    assert.deepEqual(target.dataset, { theme: 'walkman-midnight', scheme: 'dark', artwork: 'immersive' })
  })
})

describe('custom themes', () => {
  it('accepts colours only, rejects unreadable text, ignores unknown keys', () => {
    const ok = checkCustomTheme({ name: 'Night', base: 'amoled', tokens: { background: '#000000', accent: '#ff8800', fontFamily: 'Comic Sans' }, corners: 'soft' })
    assert.equal(ok.ok, true)
    assert.match(ok.warnings.join(), /fontFamily/)
    assert.deepEqual(Object.keys(ok.theme!.tokens).sort(), ['accent', 'background'])
    for (const bad of [{ tokens: { background: 'red; } body { display:none' } }, { tokens: { accent: 'javascript:alert(1)' } }, { tokens: { textPrimary: '#111111', background: '#000000' } }]) {
      assert.equal(checkCustomTheme({ name: 'x', base: 'dark', ...bad }).ok, false)
    }
    assert.equal(checkCustomTheme('nope').ok, false)
  })

  it('exports and imports format 1 files strictly', () => {
    const theme = checkCustomTheme({ name: 'Walkman', base: 'dark', tokens: { accent: '#f26b3a' }, corners: 'sharp' }).theme!
    const back = importTheme(exportTheme(theme))
    assert.equal(back.ok, true)
    assert.deepEqual(back.theme, theme)
    assert.equal(importTheme('{"format":2}').ok, false)
    assert.equal(importTheme('<script>').ok, false)
  })
})

describe('per-device preferences', () => {
  it('are saved locally and survive a reload; garbage falls back safely', () => {
    const storage = memory()
    saveAppearance({ ...DEFAULT_APPEARANCE, theme: 'amoled', artwork: 'immersive', accent: 'blue' }, storage)
    assert.deepEqual(loadAppearance(storage), { ...DEFAULT_APPEARANCE, theme: 'amoled', artwork: 'immersive', accent: 'blue' })
    assert.deepEqual(loadAppearance(memory({ 'pandafm.appearance': '{not json' })), DEFAULT_APPEARANCE)
    assert.deepEqual(loadAppearance(memory({ 'pandafm.appearance': '{"theme":"custom","custom":{"tokens":{"background":"x"}}}' })), DEFAULT_APPEARANCE)
    assert.equal(loadAppearance(memory({ 'pandafm.appearance': '{"theme":"light","artwork":"loud","accent":"neon"}' })).artwork, 'subtle')
  })
})
