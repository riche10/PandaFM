// Semantic design tokens and PandaFM's built-in themes. Every screen styles
// itself with these names (see :root in styles.css), never with raw colours.

export const TOKENS = [
  'background', 'background-elevated', 'surface', 'surface-hover', 'surface-selected',
  'text-primary', 'text-secondary', 'text-muted', 'border', 'border-strong', 'control-track',
  'accent', 'accent-contrast', 'danger', 'success', 'player-background', 'sidebar-background',
  'navigation-background', 'overlay', 'shadow-strength', 'radius-small', 'radius-medium', 'radius-large',
] as const

export type Token = (typeof TOKENS)[number]
export type Tokens = Record<Token, string>
export type Scheme = 'light' | 'dark'

export interface ThemeDefinition {
  id: string
  label: string
  description: string
  scheme: Scheme
  tokens: Tokens
}

const radius = (small: number, medium: number, large: number) => ({
  'radius-small': `${small}px`, 'radius-medium': `${medium}px`, 'radius-large': `${large}px`,
})

const PANDA_CLASSIC: ThemeDefinition = {
  id: 'panda-classic',
  label: 'Panda Classic',
  description: 'Warm ink, ivory and a Walkman-orange accent',
  scheme: 'dark',
  tokens: {
    background: '#0f0e0d', 'background-elevated': '#1d1b19', surface: '#181614', 'surface-hover': '#24211e', 'surface-selected': '#2e2a26',
    'text-primary': '#f4efe6', 'text-secondary': '#b4aca1', 'text-muted': '#8a8278', border: '#2b2824', 'border-strong': '#4a453f',
    'control-track': '#4a453f', accent: '#f26b3a', 'accent-contrast': '#1a0d07', danger: '#f87171', success: '#6cc59a',
    'player-background': '#141210', 'sidebar-background': '#0f0e0d', 'navigation-background': '#0f0e0d', overlay: 'rgb(0 0 0 / 0.6)',
    'shadow-strength': '1', ...radius(6, 10, 16),
  },
}

const DARK: ThemeDefinition = {
  id: 'dark',
  label: 'Dark',
  description: 'Charcoal and warm white; artwork brings the colour',
  scheme: 'dark',
  tokens: {
    background: '#141312', 'background-elevated': '#211f1d', surface: '#1b1a18', 'surface-hover': '#262422', 'surface-selected': '#302d2a',
    'text-primary': '#f5f2ed', 'text-secondary': '#aaa39b', 'text-muted': '#857e76', border: '#2c2a27', 'border-strong': '#4b4743',
    'control-track': '#4b4743', accent: '#f2eee8', 'accent-contrast': '#141312', danger: '#f87171', success: '#6cc59a',
    'player-background': '#181715', 'sidebar-background': '#141312', 'navigation-background': '#141312', overlay: 'rgb(0 0 0 / 0.6)',
    'shadow-strength': '1', ...radius(6, 8, 14),
  },
}

const AMOLED: ThemeDefinition = {
  id: 'amoled',
  label: 'AMOLED',
  description: 'True black, kind to OLED screens and batteries',
  scheme: 'dark',
  tokens: {
    background: '#000000', 'background-elevated': '#0f0f0f', surface: '#0a0a0a', 'surface-hover': '#171717', 'surface-selected': '#212121',
    'text-primary': '#f2f2f2', 'text-secondary': '#a8a8a8', 'text-muted': '#858585', border: '#2a2a2a', 'border-strong': '#454545',
    'control-track': '#3d3d3d', accent: '#f2f2f2', 'accent-contrast': '#000000', danger: '#f87171', success: '#6cc59a',
    'player-background': '#000000', 'sidebar-background': '#000000', 'navigation-background': '#000000', overlay: 'rgb(0 0 0 / 0.75)',
    'shadow-strength': '0.6', ...radius(6, 8, 14),
  },
}

const LIGHT: ThemeDefinition = {
  id: 'light',
  label: 'Light',
  description: 'Warm paper and charcoal, easy on the eyes',
  scheme: 'light',
  tokens: {
    background: '#f6f3ee', 'background-elevated': '#fdfbf8', surface: '#eeeae3', 'surface-hover': '#e6e1d9', 'surface-selected': '#ddd7cd',
    'text-primary': '#23201c', 'text-secondary': '#57514a', 'text-muted': '#6f685f', border: '#ddd6cc', 'border-strong': '#b3aa9e',
    'control-track': '#cfc7bb', accent: '#2a2622', 'accent-contrast': '#f6f3ee', danger: '#b4302a', success: '#1f6e48',
    'player-background': '#efebe4', 'sidebar-background': '#f1ede7', 'navigation-background': '#f6f3ee', overlay: 'rgb(35 30 25 / 0.35)',
    'shadow-strength': '0.3', ...radius(6, 8, 14),
  },
}

const WALKMAN_MIDNIGHT: ThemeDefinition = {
  id: 'walkman-midnight',
  label: 'Walkman Midnight',
  description: 'Deep navy, brushed silver, crisp corners',
  scheme: 'dark',
  tokens: {
    background: '#07090d', 'background-elevated': '#141923', surface: '#0f131b', 'surface-hover': '#182030', 'surface-selected': '#1f293b',
    'text-primary': '#e9eef7', 'text-secondary': '#9ba7ba', 'text-muted': '#76839a', border: '#1d2533', 'border-strong': '#34405a',
    'control-track': '#34405a', accent: '#8ab4ff', 'accent-contrast': '#07101f', danger: '#f87171', success: '#6cc59a',
    'player-background': '#0b0e14', 'sidebar-background': '#07090d', 'navigation-background': '#07090d', overlay: 'rgb(0 0 0 / 0.6)',
    'shadow-strength': '1', ...radius(3, 5, 9),
  },
}

export const BUILT_IN_THEMES: ThemeDefinition[] = [PANDA_CLASSIC, DARK, AMOLED, LIGHT, WALKMAN_MIDNIGHT]
export const THEMES: Record<string, ThemeDefinition> = Object.fromEntries(BUILT_IN_THEMES.map((t) => [t.id, t]))
export const DEFAULT_THEME = 'panda-classic'

/** Accent choices when artwork doesn't decide. "theme" keeps the theme's own accent. */
export const ACCENTS: { id: string; label: string; color: string | null }[] = [
  { id: 'theme', label: 'Theme', color: null },
  { id: 'panda', label: 'Panda', color: '#f26b3a' },
  { id: 'amber', label: 'Amber', color: '#f0a830' },
  { id: 'blue', label: 'Blue', color: '#5b9cf0' },
  { id: 'purple', label: 'Purple', color: '#a68cf0' },
  { id: 'rose', label: 'Rose', color: '#f07a9a' },
  { id: 'custom', label: 'Custom', color: null },
]
