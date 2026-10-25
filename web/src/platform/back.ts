// Android's system Back button, decided in one place.
//
// Order: close the top temporary layer (dialog, menu, sheet); otherwise go
// back in PandaFM's own history; a deep page with no history goes Home;
// at Home, leave. Browsers never use this: they keep normal navigation.

type Close = () => void

const layers: Close[] = []

/** A temporary layer (dialog, menu) is open; Back should close it first. Returns the unregister function. */
export function pushBackLayer(close: Close): () => void {
  layers.push(close)
  return () => {
    const i = layers.lastIndexOf(close)
    if (i >= 0) layers.splice(i, 1)
  }
}

export const openBackLayers = () => layers.length

export type BackAction = 'close-layer' | 'history-back' | 'go-home' | 'leave'

export function decideBack({ layers: open, pathname, historyIndex }: { layers: number; pathname: string; historyIndex: number }): BackAction {
  if (open > 0) return 'close-layer'
  if (historyIndex > 0) return 'history-back' // a PandaFM page we came from
  if (pathname !== '/') return 'go-home' // opened straight onto an inner page
  return 'leave'
}

export interface BackEnv {
  pathname: () => string
  historyIndex: () => number // React Router keeps it in history.state.idx
  goBack: () => void
  goHome: () => void
  /** Music queued: keep PandaFM (and its queue) alive in the background. */
  hasMusic: () => boolean
  minimize: () => void
  exit: () => void
}

/** Handle one Back press. Returns what it did (for tests and logs). */
export function handleBack(env: BackEnv): BackAction {
  const action = decideBack({ layers: layers.length, pathname: env.pathname(), historyIndex: env.historyIndex() })
  if (action === 'close-layer') layers[layers.length - 1]()
  else if (action === 'history-back') env.goBack()
  else if (action === 'go-home') env.goHome()
  else if (env.hasMusic()) env.minimize() // like other music apps: the music keeps going
  else env.exit()
  return action
}
