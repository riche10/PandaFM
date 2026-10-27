import { type ReactNode, useEffect, useState } from 'react'
import { authStore, checkAuth, useAuth } from '../api/auth'
import { Loading } from '../components/States'
import { useOffline } from '../offline'
import { isNative, platform } from '../platform/state'
import { ServerSetupView } from '../views/ServerSetupView'
import { SignInView } from '../views/SignInView'
import { getMusicServer, MusicServerSetup } from '../views/settings/MusicServerSettings'

const retry = () => {
  authStore.setState({ state: 'unknown' })
  void checkAuth()
}

/** Nothing of the library shows until PandaFM knows who you are (offline on Android: downloads only). */
export function AuthGate({ children }: { children: ReactNode }) {
  const { state } = useAuth()
  const [changing, setChanging] = useState(false)
  const [needsMusicServer, setNeedsMusicServer] = useState(false)
  const downloads = useOffline((s) => Object.keys(s.tracks ?? {}).length)
  useEffect(() => {
    void checkAuth()
  }, [])
  // 5.3: PandaFM no longer bundles a music server; the owner connects one right after signing in.
  useEffect(() => {
    if (state !== 'signed-in') return
    getMusicServer().then((info) => setNeedsMusicServer(!info.configured && !info.managed_by_env), () => undefined)
  }, [state])
  // Offline: try again every 30 s and whenever the network comes back.
  useEffect(() => {
    if (state !== 'offline') return
    const again = () => void checkAuth()
    const timer = setInterval(again, 30_000)
    window.addEventListener('online', again)
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', again)
    }
  }, [state])

  if (changing) return <div className="setup-screen"><ServerSetupView onDone={() => { setChanging(false); retry() }} /></div>
  if (state === 'unknown') return <div className="setup-screen"><Loading label="Connecting to PandaFM…" /></div>
  if (state === 'unreachable') {
    return (
      <div className="setup-screen">
        <div className="setup sign-in">
          <h1 className="setup-title">Can’t reach PandaFM</h1>
          <p className="hint">The server at {platform.server || 'this address'} isn’t answering. Check your connection or the address.</p>
          <div className="setup-actions">
            <button type="button" className="button" onClick={retry}>Try again</button>
            {isNative() && <button type="button" className="button button--quiet" onClick={() => setChanging(true)}>Change server address</button>}
            {isNative() && downloads > 0 && (
              <button type="button" className="button button--quiet" onClick={() => authStore.setState({ state: 'offline' })}>Play downloads ({downloads})</button>
            )}
          </div>
        </div>
      </div>
    )
  }
  if (state === 'signed-in' && needsMusicServer) return <div className="setup-screen"><MusicServerSetup onDone={() => setNeedsMusicServer(false)} /></div>
  if (state === 'signed-in' || state === 'offline') {
    return (
      <>
        {state === 'offline' && (
          <div className="offline-banner" role="status">
            <span>Can’t reach PandaFM{platform.server ? ` at ${platform.server}` : ''}. Playing downloads only.</span>
            <button type="button" className="button button--quiet" onClick={retry}>Try again</button>
            {isNative() && <button type="button" className="button button--quiet" onClick={() => setChanging(true)}>Change server</button>}
          </div>
        )}
        {children}
      </>
    )
  }
  return (
    <div className="setup-screen">
      <SignInView />
    </div>
  )
}
