import { useEffect } from 'react'
import { isNative } from '../../platform/state'
import { cancelUpdate, checkForUpdates, describe, downloadUpdate, installUpdate, updateStore, useUpdates } from '../../updates'

const mb = (bytes?: number) => (bytes ? `${(bytes / 1_048_576).toFixed(1)} MB` : '')

/**
 * Settings › App (5.4.1). Android: this build, and updates from this PandaFM server (Android's
 * installer always asks). Browsers: a link to the Android download page.
 */
export function AppSettings() {
  const state = useUpdates((s) => s)
  useEffect(() => {
    if (isNative() && updateStore.getState().phase === 'idle') void checkForUpdates(false)
  }, [])
  if (!isNative()) {
    return (
      <section className="settings-block" id="app">
        <h2 className="section-title">Android app</h2>
        <p>Install PandaFM on an Android phone or Walkman straight from this server.</p>
        <a className="button button--quiet" href="/download/android/">Get PandaFM for Android</a>
      </section>
    )
  }
  const latest = state.latest
  return (
    <section className="settings-block" id="app">
      <h2 className="section-title">App</h2>
      {state.installed && <p>PandaFM {state.installed.versionName} · Android build {state.installed.versionCode}</p>}
      <p className="hint" role="status">{describe(state)}</p>
      {state.error && state.phase !== 'error' && <p className="form-error" role="alert">{state.error}</p>}
      {latest?.notes && (state.phase === 'available' || state.phase === 'ready') && <p className="hint">{latest.notes}</p>}
      {state.phase === 'downloading' && (
        <progress className="update-progress" max={state.total || 1} value={state.received} aria-label="Update download" />
      )}
      <div className="setup-actions">
        {state.phase === 'available' && <button type="button" className="button" onClick={() => void downloadUpdate()}>Download update {mb(latest?.size)}</button>}
        {state.phase === 'downloading' && <button type="button" className="button button--quiet" onClick={() => void cancelUpdate()}>Cancel</button>}
        {(state.phase === 'ready' || state.phase === 'needs-permission') && <button type="button" className="button" onClick={() => void installUpdate()}>Install update</button>}
        {state.phase !== 'downloading' && state.phase !== 'checking' && (
          <button type="button" className="button button--quiet" onClick={() => void checkForUpdates(true)}>{state.phase === 'error' ? 'Try again' : 'Check for updates'}</button>
        )}
      </div>
    </section>
  )
}
