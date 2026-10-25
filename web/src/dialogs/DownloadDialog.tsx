import { useEffect, useState } from 'react'
import { apiSend } from '../api/client'
import { formatBytes } from '../components/QualityBadge'
import { Loading } from '../components/States'
import { toast } from '../library'
import { cacheArtwork, offline } from '../offline'
import type { Budget } from '../offline/budget'
import { updateSettings, useOfflineSettings } from '../offline/settings'
import type { CollectionKind, Manifest } from '../offline/types'
import { platform } from '../platform/state'
import { formatLength } from '../player'
import { closeDialog } from './store'

const BIG_DOWNLOAD = 5 * 1024 ** 3

/** "Download Flight Mix": choose a quality, see what it costs, check it fits. */
export function DownloadDialog({ target }: { target: { kind: CollectionKind; id: string | null; name: string } }) {
  const settings = useOfflineSettings()
  const [profile, setProfile] = useState(settings.defaultProfile)
  const [keepSynced, setKeepSynced] = useState(target.kind !== 'track')
  const [preview, setPreview] = useState<Manifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [budget, setBudget] = useState<Budget | null>(null)
  const [folder, setFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const kind = target.kind === 'track' ? 'tracks' : target.kind
    apiSend<Manifest>('POST', '/downloads/prepare', { kind, id: target.kind === 'track' ? null : target.id, track_ids: target.kind === 'track' && target.id ? [target.id] : [], profile: 'original', warm: false })
      .then(setPreview, (err: Error) => setError(err.message))
    offline()?.budget().then(setBudget, () => undefined)
    platform.storage?.getDirectory().then((d) => setFolder(d.writable ? d.name : null)).catch(() => undefined)
  }, [target.kind, target.id])

  const estimate = preview?.estimates.find((e) => e.profile === profile)
  // A first look; the download manager checks precisely (songs already on the device don't count again).
  const tooBig = estimate && budget?.remainingBytes != null && estimate.bytes > budget.remainingBytes
  const tracks = preview?.items.length ?? 0

  const chooseFolder = async () => {
    try {
      const picked = await platform.storage!.pickDirectory()
      setFolder(picked.name)
    } catch {
      // cancelled
    }
  }

  const start = async () => {
    const manager = offline()
    if (!manager) return
    if (estimate && estimate.bytes > BIG_DOWNLOAD && !window.confirm(`This is about ${formatBytes(estimate.bytes)}. Download it?`)) return
    setBusy(true)
    try {
      updateSettings({ defaultProfile: profile })
      const collection = await manager.download(target, profile, keepSynced)
      void cacheArtwork([...new Set(preview?.items.map((i) => i.track.cover_art_id) ?? [])])
      toast(`Downloading ${collection.name}`)
      closeDialog()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t start the download.')
      setBusy(false)
    }
  }

  return (
    <>
      <h2 className="modal-title">Download {target.name}</h2>
      {preview ? (
        <p className="modal-subtitle">
          {tracks === 1 ? '1 song' : `${tracks} songs`} · {formatLength(preview.duration_seconds)}
        </p>
      ) : error ? null : (
        <Loading label="Working out sizes…" />
      )}
      {preview && (
        <fieldset className="profile-list">
          <legend className="field-label">Quality</legend>
          {preview.estimates.map((e) => (
            <label key={e.profile} className="profile-option">
              <input type="radio" name="profile" value={e.profile} checked={profile === e.profile} onChange={() => setProfile(e.profile)} />
              <span className="profile-name">{e.label}</span>
              <span className="profile-size">{e.exact ? formatBytes(e.bytes) : `≈ ${formatBytes(e.bytes)}`}</span>
            </label>
          ))}
          <p className="hint profile-note">Lossy songs are never turned into FLAC: they stay as they are.</p>
        </fieldset>
      )}
      <dl className="download-facts">
        <div><dt>Saved to</dt><dd>{folder ?? 'No folder chosen yet'}</dd></div>
        <div><dt>Free on storage</dt><dd>{budget?.freeBytes != null ? formatBytes(budget.freeBytes) : 'Unknown'}</dd></div>
        <div><dt>PandaFM may still use</dt><dd>{budget?.remainingBytes != null ? formatBytes(budget.remainingBytes) : 'Up to the free space'}</dd></div>
        {estimate && <div><dt>{estimate.exact ? 'Needs' : 'Needs about'}</dt><dd>{formatBytes(estimate.bytes)}</dd></div>}
      </dl>
      {budget?.overLimit && <p className="field-error">PandaFM is over this device’s storage limit. Remove some downloads or raise the limit in Settings.</p>}
      {tooBig && !budget?.overLimit && <p className="field-warning">This may not fit under this device’s storage limit. Songs you already have don’t count again.</p>}
      {target.kind !== 'track' && (
        <label className="check-option">
          <input type="checkbox" checked={keepSynced} onChange={(e) => setKeepSynced(e.target.checked)} />
          Keep downloaded (follow changes to it)
        </label>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="button button--quiet" onClick={closeDialog}>Cancel</button>
        {folder ? (
          <button type="button" className="button" disabled={!preview || busy} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Start download'}
          </button>
        ) : (
          <button type="button" className="button" onClick={() => void chooseFolder()}>Choose a folder</button>
        )}
      </div>
    </>
  )
}
