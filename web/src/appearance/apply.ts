import { resolveAppearance, type Resolved } from './resolve.ts'
import { appearanceStore } from './store.ts'
import { TOKENS } from './themes.ts'

// Applies the current appearance to the page as CSS variables. Instant, no
// reload, so playback and the queue carry on untouched.

interface Target {
  style: { setProperty(name: string, value: string): void }
  dataset: Record<string, string | undefined>
}

export function applyResolved(target: Target, r: Resolved): void {
  for (const token of TOKENS) target.style.setProperty(`--${token}`, r.tokens[token])
  target.style.setProperty('color-scheme', r.scheme)
  target.dataset.theme = r.themeId
  target.dataset.scheme = r.scheme
  target.dataset.artwork = r.artwork
}

let current: Resolved | null = null
let version = 0
const listeners = new Set<() => void>()
export const currentAppearance = () => current
/** For useSyncExternalStore: re-render when the appearance changes. */
export const subscribeAppearance = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export const appearanceVersion = () => version

/** Start following preferences and the system's light/dark setting. Call once at start-up. */
export function startAppearance(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  const apply = (animate: boolean) => {
    current = resolveAppearance(appearanceStore.getState(), media?.matches ?? true)
    if (animate && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      root.classList.add('theme-changing')
      window.setTimeout(() => root.classList.remove('theme-changing'), 350)
    }
    applyResolved(root as unknown as Target, current)
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', current.tokens.background)
    version++
    for (const l of listeners) l()
  }
  apply(false)
  appearanceStore.subscribe(() => apply(true))
  media?.addEventListener?.('change', () => apply(true))
}
