import { useEffect, useState } from 'react'
import { apiGet } from '../api/client'
import { fetchHealth } from '../api/health'
import { PageHeader } from '../components/PageHeader'
import { formatBytes } from '../components/QualityBadge'
import { useOffline } from '../offline'
import { updateSettings, useOfflineSettings } from '../offline/settings'
import { isNative, platform } from '../platform/state'
import { ServerSetupView } from './ServerSetupView'
import { AppearanceSettings } from './settings/AppearanceSettings'
import { RadioSettings } from './settings/RadioSettings'
import { Diagnostics } from './settings/Diagnostics'
import { AccountSettings } from './settings/AccountSettings'
import { MusicServerSettings } from './settings/MusicServerSettings'
import { StreamingQuality } from './settings/StreamingQuality'
import { StorageLimit } from './settings/StorageLimit'
import { useAutoplaySettings, autoplaySettings } from '../player/autoplay'
import { usePresets } from '../library/presets'

const PROFILES = [
  ['original', 'Original'],
  ['lossless_portable', 'Lossless Portable'],
  ['high_quality', 'High Quality'],
  ['space_saver', 'Space Saver'],
] as const

export function SettingsView() {
  const settings = useOfflineSettings()
  const autoplay = useAutoplaySettings()
  const { presets } = usePresets()
  const [health, setHealth] = useState<string>('Checking…')
  const [changing, setChanging] = useState(false)
  const [folder, setFolder] = useState<string | null>(null)
  const [space, setSpace] = useState<{ freeBytes: number | null } | null>(null)
  const [cache, setCache] = useState<{ bytes: number; max_bytes: number } | null>(null)
  const used = useOffline((s) => Object.values(s.tracks).reduce((sum, t) => sum + (t.status === 'downloaded' ? (t.sizeBytes ?? 0) : 0), 0))
  const downloaded = useOffline((s) => Object.values(s.tracks).filter((t) => t.status === 'downloaded').length)

  useEffect(() => {
    fetchHealth().then((h) => setHealth(h.status === 'ok' ? 'Connected' : 'Connected, but something isn’t healthy'), () => setHealth('Not reachable'))
    apiGet<{ bytes: number; max_bytes: number }>('/downloads/cache').then(setCache, () => undefined)
    platform.storage?.getDirectory().then((d) => setFolder(d.writable ? d.name : null)).catch(() => undefined)
    platform.storage?.getStorageInfo().then(setSpace).catch(() => undefined)
  }, [])

  const chooseFolder = async () => {
    try {
      const picked = await platform.storage!.pickDirectory()
      setFolder(picked.name)
      setSpace(await platform.storage!.getStorageInfo())
    } catch {
      // cancelled
    }
  }

  if (changing) return <ServerSetupView />

  return (
    <div className="page page--settings">
      <PageHeader />
      <h1 className="page-title">Settings</h1>
      <nav className="settings-nav" aria-label="Settings sections">
        {[['account', 'Account'], ['appearance', 'Appearance'], ['radio', 'Radio'], ['playback', 'Playback'], ...(isNative() ? [['offline', 'Offline']] : []), ['server', 'Server']].map(([id, label]) => (
          <button key={id} type="button" className="chip" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{label}</button>
        ))}
      </nav>

      <AccountSettings />
      <MusicServerSettings />
      <AppearanceSettings />
      <RadioSettings />

      <section className="settings-block" id="playback">
        <h2 className="section-title">Playback</h2>
        <StreamingQuality />
        <label className="check-option">
          <input type="checkbox" checked={autoplay.enabled} onChange={(e) => autoplaySettings.setState({ enabled: e.target.checked })} />
          Autoplay: continue with Panda Radio when my music ends
        </label>
        <label className="field">
          <span className="field-label">Autoplay mode</span>
          <select className="field-input" value={autoplay.preset} disabled={!autoplay.enabled} onChange={(e) => autoplaySettings.setState({ preset: e.target.value })}>
            {(presets ?? [{ id: 'panda', name: 'Panda Radio' }]).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <p className="hint">Saved on this device. Repeat, songs you queued and End Radio always come first.</p>
        {isNative() && (
          <>
            <label className="check-option">
              <input type="checkbox" checked={settings.preferLocal} onChange={(e) => updateSettings({ preferLocal: e.target.checked })} />
              Prefer downloaded files
            </label>
            <label className="check-option">
              <input type="checkbox" checked={settings.streamFallback} onChange={(e) => updateSettings({ streamFallback: e.target.checked })} />
              Stream when a song isn’t downloaded
            </label>
          </>
        )}
      </section>



      {isNative() ? (
        <>
          <section className="settings-block" id="offline">
            <h2 className="section-title">Offline storage</h2>
            <p>{folder ?? 'No folder chosen yet. Pick or create a PandaFM folder, for example on your SD card.'}</p>
            <p className="hint">
              {downloaded} songs · {formatBytes(used)} used{space?.freeBytes != null ? ` · ${formatBytes(space.freeBytes)} free` : ''}
            </p>
            <button type="button" className="button button--quiet" onClick={() => void chooseFolder()}>{folder ? 'Change location' : 'Choose folder'}</button>
            <StorageLimit />
          </section>

          <section className="settings-block">
            <h2 className="section-title">Downloads</h2>
            <label className="field">
              <span className="field-label">Default quality</span>
              <select className="field-input" value={settings.defaultProfile} onChange={(e) => updateSettings({ defaultProfile: e.target.value })}>
                {PROFILES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
            <fieldset className="radio-group">
              <legend className="field-label">Download and sync over</legend>
              {(['wifi', 'any', 'manual'] as const).map((policy) => (
                <label key={policy} className="check-option">
                  <input type="radio" name="policy" checked={settings.syncPolicy === policy} onChange={() => updateSettings({ syncPolicy: policy })} />
                  {policy === 'wifi' ? 'Wi-Fi only' : policy === 'any' ? 'Any network (uses mobile data)' : 'Manual sync only (downloads still wait for Wi-Fi)'}
                </label>
              ))}
            </fieldset>
            <label className="field">
              <span className="field-label">Downloads at once</span>
              <select className="field-input" value={settings.concurrency} onChange={(e) => updateSettings({ concurrency: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </section>


        </>
      ) : (
        <section className="settings-block">
          <h2 className="section-title">Downloads</h2>
          <p className="hint">Offline downloads are available in the PandaFM Android app.</p>
        </section>
      )}

      {cache && (
        <section className="settings-block">
          <h2 className="section-title">Server conversion cache</h2>
          <p className="hint">{formatBytes(cache.bytes)} of {formatBytes(cache.max_bytes)} used. Converted copies are remade when needed.</p>
        </section>
      )}
      <section className="settings-block" id="server">
        <h2 className="section-title">Server</h2>
        <p>{isNative() ? platform.server : 'This browser uses the PandaFM server it was opened from.'}</p>
        <p className="hint">Status: {health}</p>
        {isNative() && <button type="button" className="button button--quiet" onClick={() => setChanging(true)}>Change server</button>}
      </section>
      <Diagnostics />
    </div>
  )
}
