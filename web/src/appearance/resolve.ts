import { contrast, ensureContrast, isHex, mix, readableOn } from './color.ts'
import { ACCENTS, DEFAULT_THEME, type Scheme, THEMES, type Tokens } from './themes.ts'

// Turns preferences into the exact tokens to apply. Pure: no DOM, no storage.

export type ArtworkMode = 'off' | 'subtle' | 'immersive'
export type CornerStyle = 'sharp' | 'rounded' | 'soft'

/** What a custom theme may set. Only these, only hex colours: no CSS, no URLs, no scripts. */
export const CUSTOM_FIELDS = ['background', 'surface', 'textPrimary', 'textSecondary', 'accent', 'border'] as const
export type CustomField = (typeof CUSTOM_FIELDS)[number]

export interface CustomTheme {
  name: string
  base: string // a built-in theme id
  tokens: Partial<Record<CustomField, string>>
  corners: CornerStyle
}

export interface Appearance {
  theme: string // 'system' | built-in id | 'custom'
  artwork: ArtworkMode
  accent: string // ACCENTS id
  customAccent: string
  custom: CustomTheme | null
}

export const DEFAULT_APPEARANCE: Appearance = { theme: DEFAULT_THEME, artwork: 'subtle', accent: 'theme', customAccent: '#f26b3a', custom: null }

const CORNERS: Record<CornerStyle, [number, number, number]> = { sharp: [2, 4, 6], rounded: [6, 8, 14], soft: [10, 14, 22] }
const MIN_TEXT_CONTRAST = 4.5

export interface CustomCheck {
  ok: boolean
  errors: string[]
  warnings: string[]
  theme: CustomTheme | null
}

/** Strictly validate a custom theme (from the editor, storage or an imported file). */
export function checkCustomTheme(input: unknown): CustomCheck {
  const errors: string[] = []
  const warnings: string[] = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['Not a PandaFM theme.'], warnings, theme: null }
  const raw = input as Record<string, unknown>
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : 'My theme'
  const base = typeof raw.base === 'string' && THEMES[raw.base] ? raw.base : DEFAULT_THEME
  const corners: CornerStyle = raw.corners === 'sharp' || raw.corners === 'soft' ? raw.corners : 'rounded'
  const tokens: CustomTheme['tokens'] = {}
  const given = raw.tokens && typeof raw.tokens === 'object' && !Array.isArray(raw.tokens) ? (raw.tokens as Record<string, unknown>) : {}
  for (const [key, value] of Object.entries(given)) {
    if (!(CUSTOM_FIELDS as readonly string[]).includes(key)) {
      warnings.push(`Ignored unknown setting “${key.slice(0, 30)}”.`)
      continue
    }
    if (!isHex(value)) {
      errors.push(`“${key}” must be a colour like #1a2b3c.`)
      continue
    }
    tokens[key as CustomField] = value.toLowerCase()
  }
  const theme: CustomTheme = { name, base, tokens, corners }
  const t = customTokens(theme)
  if (contrast(t['text-primary'], t.background) < MIN_TEXT_CONTRAST) errors.push('Primary text is too hard to read on the background.')
  if (contrast(t['text-primary'], t.surface) < MIN_TEXT_CONTRAST) errors.push('Primary text is too hard to read on surfaces.')
  if (contrast(t['text-secondary'], t.background) < 3) warnings.push('Secondary text is low-contrast; it was adjusted to stay readable.')
  return { ok: errors.length === 0, errors, warnings, theme: errors.length === 0 ? theme : null }
}

/** Full token set for a custom theme: its base, the chosen values, and sensible derivations. */
export function customTokens(theme: CustomTheme): Tokens {
  const base = THEMES[theme.base] ?? THEMES[DEFAULT_THEME]
  const t: Tokens = { ...base.tokens }
  const c = theme.tokens
  if (c.background) {
    t.background = c.background
    t['sidebar-background'] = c.background
    t['navigation-background'] = c.background
  }
  if (c.surface) {
    t.surface = c.surface
    t['background-elevated'] = mix(c.surface, t['text-primary'], 0.04)
    t['player-background'] = c.surface
  }
  if (c.textPrimary) t['text-primary'] = c.textPrimary
  t['text-secondary'] = ensureContrast(c.textSecondary ?? t['text-secondary'], t.background, 4.5)
  t['text-muted'] = ensureContrast(mix(t['text-secondary'], t.background, 0.25), t.background, 3)
  t['surface-hover'] = mix(t.surface, t['text-primary'], 0.07)
  t['surface-selected'] = mix(t.surface, t['text-primary'], 0.13)
  if (c.border) t.border = c.border
  t['border-strong'] = ensureContrast(mix(t.border, t['text-primary'], 0.25), t.background, 1.8)
  t['control-track'] = t['border-strong']
  if (c.accent) t.accent = c.accent
  t['accent-contrast'] = readableOn(t.accent)
  const [s, m, l] = CORNERS[theme.corners]
  Object.assign(t, { 'radius-small': `${s}px`, 'radius-medium': `${m}px`, 'radius-large': `${l}px` })
  return t
}

export interface Resolved {
  themeId: string
  scheme: Scheme
  tokens: Tokens
  artwork: ArtworkMode
}

/** The tokens to apply, given preferences and whether the system is in dark mode. */
export function resolveAppearance(a: Appearance, systemDark: boolean): Resolved {
  let themeId = a.theme === 'system' ? (systemDark ? 'dark' : 'light') : a.theme
  let tokens: Tokens
  let scheme: Scheme
  const custom = themeId === 'custom' && a.custom ? checkCustomTheme(a.custom) : null
  if (custom?.ok && custom.theme) {
    tokens = customTokens(custom.theme)
    scheme = THEMES[custom.theme.base].scheme
  } else {
    if (!THEMES[themeId]) themeId = DEFAULT_THEME // unknown or broken: fall back, never break
    tokens = { ...THEMES[themeId].tokens }
    scheme = THEMES[themeId].scheme
  }
  const choice = ACCENTS.find((x) => x.id === a.accent)
  const color = a.accent === 'custom' && isHex(a.customAccent) ? a.customAccent : (choice?.color ?? null)
  if (color) {
    // Keep a chosen accent visible on this theme's background, with readable icons on it.
    tokens.accent = ensureContrast(color, tokens.background, 3)
    tokens['accent-contrast'] = readableOn(tokens.accent)
  }
  return { themeId, scheme, tokens, artwork: a.artwork }
}

/** A theme file anyone can share: format 1, colours only. */
export function exportTheme(theme: CustomTheme): string {
  return JSON.stringify({ format: 1, name: theme.name, base: theme.base, corners: theme.corners, tokens: theme.tokens }, null, 2)
}

export function importTheme(text: string): CustomCheck {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, errors: ['That file isn’t valid JSON.'], warnings: [], theme: null }
  }
  if (!data || typeof data !== 'object' || (data as { format?: unknown }).format !== 1) {
    return { ok: false, errors: ['Not a PandaFM theme file (format 1).'], warnings: [], theme: null }
  }
  return checkCustomTheme(data)
}
