import { type ReactNode, useEffect } from 'react'
import { checkAuth, useAuth } from '../api/auth'
import { Loading } from '../components/States'
import { SignInView } from '../views/SignInView'

/** Nothing of the library shows until PandaFM knows who you are (offline on Android: downloads only). */
export function AuthGate({ children }: { children: ReactNode }) {
  const { state } = useAuth()
  useEffect(() => {
    void checkAuth()
  }, [])
  if (state === 'unknown') return <div className="setup-screen"><Loading label="Connecting to PandaFM…" /></div>
  if (state === 'signed-in' || state === 'offline') return <>{children}</>
  return (
    <div className="setup-screen">
      <SignInView />
    </div>
  )
}
