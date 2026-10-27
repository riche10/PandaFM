import { useEffect, useState } from 'react'
import { apiGet } from '../api/client'
import { MusicServerForm } from '../components/MusicServerForm'
import { SetupSteps } from '../components/SetupSteps'
import { Wordmark } from '../components/Wordmark'

/** First run, after the owner account: connect the music server, import the library, done. */
export function MusicServerSetup({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'connect' | 'import' | 'ready'>('connect')
  const [sync, setSync] = useState<{ running?: boolean; [k: string]: unknown } | null>(null)
  useEffect(() => {
    if (step !== 'import') return
    let live = true
    const poll = async () => {
      const s = await apiGet<{ running?: boolean; [k: string]: unknown }>('/library/sync').catch(() => null)
      if (!live) return
      setSync(s)
      if (s && !s.running) setStep('ready')
      else setTimeout(() => void poll(), 2000)
    }
    const first = setTimeout(() => void poll(), 1000)
    return () => { live = false; clearTimeout(first) }
  }, [step])
  return (
    <div className="page setup">
      <Wordmark size="large" />
      <SetupSteps current={step === 'connect' ? 2 : step === 'import' ? 3 : 4} />
      {step === 'connect' && (
        <>
          <h1 className="page-title setup-title">Connect your music server</h1>
          <p>PandaFM plays the music from your Navidrome (or another OpenSubsonic) server. Enter its address and an account PandaFM can use.</p>
          <MusicServerForm onSaved={() => setStep('import')} saveLabel="Save and continue" />
        </>
      )}
      {step === 'import' && (
        <>
          <h1 className="page-title setup-title">Connected</h1>
          <p role="status">PandaFM is importing your library… You can keep this open or come back later: it continues in the background.</p>
          {typeof sync?.tracks === 'number' && <p className="hint">{String(sync.tracks)} songs so far</p>}
          <div className="setup-actions">
            <button type="button" className="button button--quiet" onClick={onDone}>Continue while it imports</button>
          </div>
        </>
      )}
      {step === 'ready' && (
        <>
          <h1 className="page-title setup-title">Ready</h1>
          <p>Your library is in PandaFM. Enjoy the music.</p>
          <div className="setup-actions">
            <button type="button" className="button" onClick={onDone}>Start listening</button>
          </div>
        </>
      )}
    </div>
  )
}
