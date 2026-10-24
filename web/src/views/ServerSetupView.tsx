import { type FormEvent, useState } from 'react'
import { Icon } from '../components/Icon'
import { Wordmark } from '../components/Wordmark'
import { checkServer, type ServerCheck, saveServer } from '../platform/server'
import { platform } from '../platform/state'

/** The Android app's first screen (and Settings › Change server): which PandaFM to use. */
export function ServerSetupView({ onDone }: { onDone?: () => void }) {
  const [address, setAddress] = useState(platform.server)
  const [check, setCheck] = useState<ServerCheck | null>(null)
  const [busy, setBusy] = useState(false)

  const test = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setCheck(await checkServer(address))
    setBusy(false)
  }

  const finish = () => {
    if (!check?.ok) return
    saveServer(check.url)
    if (onDone) onDone()
    else window.location.reload() // start fresh against the new server
  }

  return (
    <div className="page setup">
      <Wordmark size="large" />
      <h1 className="page-title setup-title">Your PandaFM server</h1>
      <p className="hint">The address you use for PandaFM in a browser, for example https://music.example.com.</p>
      <form className="setup-form" onSubmit={(e) => void test(e)}>
        <label className="field">
          <span className="field-label">Server address</span>
          <input
            className="field-input"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value)
              setCheck(null)
            }}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://music.example.com"
          />
        </label>
        <button type="submit" className="button button--quiet" disabled={busy || !address.trim()}>
          {busy ? 'Testing…' : 'Test connection'}
        </button>
      </form>
      {check && (
        <div className="setup-result" role="status">
          <ul className="setup-steps">
            {check.steps.map((step) => (
              <li key={step.label} data-ok={step.ok ? '' : undefined}>
                <Icon name={step.ok ? 'downloaded' : 'alert'} />
                {step.label}
                {step.detail ? ` (${step.detail})` : ''}
              </li>
            ))}
          </ul>
          {check.message && <p className="field-error">{check.message}</p>}
        </div>
      )}
      <button type="button" className="button setup-continue" disabled={!check?.ok} onClick={finish}>
        Continue
      </button>
    </div>
  )
}
