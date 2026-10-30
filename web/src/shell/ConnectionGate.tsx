import { type ReactNode, useEffect, useState } from 'react'
import { Loading } from '../components/States'
import { SetupSteps } from '../components/SetupSteps'
import { Wordmark } from '../components/Wordmark'
import { checkConnection, continueOffline, useConnection } from '../api/connection'
import { hasDownloads, onReconnect } from '../offline'
import { displayHost, interruptedMessage } from '../platform/connection'
import { isNative, platform } from '../platform/state'
import { MusicServerSetup } from '../views/MusicServerSetup'
import { ServerSetupView } from '../views/ServerSetupView'
import { SignInView } from '../views/SignInView'

/**
 * Chooses the first screen from one connection state (5.3), so a missing
 * address, an unreachable server, an unfinished setup, a signed-out device and
 * a music server that's down are each answered differently.
 */
export function ConnectionGate({ children }: { children: ReactNode }) {
  const state = useConnection((s) => s.state)
  useEffect(() => {
    void checkConnection({ trigger: 'launch' })
    return onReconnect(() => void checkConnection({ trigger: 'back online' }))
  }, [])
  const screen = (content: ReactNode) => <div className="setup-screen">{content}</div>
  switch (state) {
    case 'checking':
      return screen(<Loading label="Connecting to PandaFM…" />)
    case 'no-server':
      return screen(<ServerSetupView onDone={() => void checkConnection()} />)
    case 'server-unreachable':
      return screen(<ServerUnreachable />)
    case 'setup-required':
      return screen(<OwnerSetup />)
    case 'sign-in-required':
      return screen(<SignInView />)
    case 'music-server-required':
      return screen(<MusicServerSetup onDone={() => void checkConnection()} />)
    default:
      return (
        <>
          {(state === 'degraded' || state === 'offline' || state === 'interrupted') && <ConnectionBanner state={state} />}
          {children}
        </>
      )
  }
}

function ServerUnreachable() {
  const [changing, setChanging] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const probe = useConnection((s) => s.probe)
  if (changing) return <ServerSetupView onDone={() => void checkConnection()} />
  const retry = async () => {
    setRetrying(true)
    await checkConnection({ fresh: true, trigger: 'try again' })
    setRetrying(false)
  }
  const host = isNative() ? displayHost(platform.server) : window.location.host
  return (
    <div className="page setup connection-problem" role="alert">
      <Wordmark size="large" />
      <h1 className="page-title setup-title">Can’t reach your PandaFM server</h1>
      <p className="setup-host">{host}</p>
      <p>
        {probe === 'not-pandafm'
          ? 'Something answered at that address, but it isn’t PandaFM. Check the address.'
          : 'It may be turned off, restarting, or out of reach of this network. Your settings are kept.'}
      </p>
      <div className="setup-actions">
        <button type="button" className="button" disabled={retrying} onClick={() => void retry()}>{retrying ? 'Trying…' : 'Try again'}</button>
        {isNative() && <button type="button" className="button button--quiet" onClick={() => setChanging(true)}>Change server</button>}
        {isNative() && hasDownloads() && <button type="button" className="button button--quiet" onClick={continueOffline}>Continue offline</button>}
      </div>
    </div>
  )
}

function OwnerSetup() {
  const [started, setStarted] = useState(false)
  if (!started) {
    return (
      <div className="page setup">
        <Wordmark size="large" />
        <SetupSteps current={0} />
        <h1 className="page-title setup-title">Welcome to PandaFM</h1>
        <p>PandaFM plays the music from your own Navidrome (or other OpenSubsonic) server, with Panda Radio, Panda Mix and the Android app.</p>
        <p>Setting up takes a minute: create the owner account, connect your music server, and PandaFM imports your library.</p>
        <div className="setup-actions">
          <button type="button" className="button" onClick={() => setStarted(true)}>Get started</button>
        </div>
      </div>
    )
  }
  return (
    <>
      <SetupSteps current={1} />
      <SignInView />
    </>
  )
}

function ConnectionBanner({ state }: { state: 'degraded' | 'offline' | 'interrupted' }) {
  const configured = useConnection((s) => s.setup?.music_server_configured ?? true)
  const failures = useConnection((s) => s.failures)
  return (
    <div className="connection-banner" role="status">
      <span>
        {state === 'interrupted'
          ? interruptedMessage(failures)
          : state === 'offline'
          ? 'Offline: playing your downloads. Your PandaFM server is kept.'
          : configured
            ? 'Your music server isn’t responding. Downloads still play; the library may be out of date.'
            : 'No music server is connected yet.'}
      </span>
      <button type="button" className="button button--quiet" onClick={() => void checkConnection({ fresh: true, trigger: 'try again' })}>Try again</button>
    </div>
  )
}
