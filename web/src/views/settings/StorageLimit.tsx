import { useEffect, useState } from 'react'
import { formatBytes } from '../../components/QualityBadge'
import { offline, useOffline } from '../../offline'
import type { Budget } from '../../offline/budget'
import { updateSettings, useOfflineSettings } from '../../offline/settings'

const PRESETS = [32, 64, 128, 256]

/** How much of this device PandaFM may fill (this device only: phone and Walkman can differ). */
export function StorageLimit() {
  const s = useOfflineSettings()
  const tracks = useOffline((state) => state.tracks)
  const [budget, setBudget] = useState<Budget | null>(null)
  const [custom, setCustom] = useState(s.storageMode === 'fixed' && !PRESETS.includes(s.storageLimitGb))

  useEffect(() => {
    offline()?.budget().then(setBudget, () => undefined)
  }, [s.storageMode, s.storageLimitGb, s.reserveGb, tracks])

  const used = (budget?.usedBytes ?? 0) + (budget?.pendingBytes ?? 0)
  const capacity = budget?.limitBytes ?? (budget?.freeBytes != null ? used + budget.freeBytes : null)
  const limitText = s.storageMode === 'fixed' ? `${s.storageLimitGb} GB` : 'Use available space'
  return (
    <div className="storage-limit">
      <span className="field-label">Offline storage limit</span>
      <div className="segmented" role="group" aria-label="Offline storage limit">
        {PRESETS.map((gb) => (
          <button key={gb} type="button" className="chip" aria-pressed={s.storageMode === 'fixed' && !custom && s.storageLimitGb === gb}
            onClick={() => { setCustom(false); updateSettings({ storageMode: 'fixed', storageLimitGb: gb }) }}>{gb} GB</button>
        ))}
        <button type="button" className="chip" aria-pressed={s.storageMode === 'fixed' && custom} onClick={() => { setCustom(true); updateSettings({ storageMode: 'fixed' }) }}>Custom</button>
        <button type="button" className="chip" aria-pressed={s.storageMode === 'available'} onClick={() => { setCustom(false); updateSettings({ storageMode: 'available' }) }}>Use available space</button>
      </div>
      {s.storageMode === 'fixed' && custom && (
        <label className="field">
          <span className="field-label">Limit (GB)</span>
          <input className="field-input" type="number" inputMode="numeric" min={1} max={100000} value={s.storageLimitGb}
            onChange={(e) => { const v = Math.round(Number(e.target.value)); if (v > 0) updateSettings({ storageLimitGb: v }) }} />
        </label>
      )}
      {s.storageMode === 'available' && (
        <label className="field">
          <span className="field-label">Reserve free space (GB)</span>
          <input className="field-input" type="number" inputMode="numeric" min={0} max={10000} value={s.reserveGb}
            onChange={(e) => { const v = Math.round(Number(e.target.value)); if (v >= 0) updateSettings({ reserveGb: v }) }} />
        </label>
      )}
      {capacity != null && capacity > 0 && <progress className="storage-meter" max={capacity} value={Math.min(used, capacity)} aria-label="PandaFM storage use" />}
      <p className="hint">
        {formatBytes(budget?.usedBytes ?? 0)} used by PandaFM{budget?.pendingBytes ? ` (+${formatBytes(budget.pendingBytes)} downloading)` : ''}
        {budget?.freeBytes != null ? ` · ${formatBytes(budget.freeBytes)} free on selected storage` : ''}
        {` · Limit: ${limitText}`}
        {s.storageMode === 'available' ? ` · ${s.reserveGb} GB reserved` : ''}
      </p>
      {budget?.overLimit && (
        <p className="field-error">PandaFM is over this limit. Nothing is deleted, but new downloads wait until you remove some or raise the limit.</p>
      )}
    </div>
  )
}
