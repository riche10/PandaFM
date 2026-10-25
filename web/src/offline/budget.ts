// How much more PandaFM may download on THIS device. Chosen per device (a
// phone and a Walkman can differ), never on the server. Pure: the download
// manager supplies the numbers and enforces the answer.

export const GB = 1024 ** 3

export interface BudgetSettings {
  storageMode: 'fixed' | 'available'
  storageLimitGb: number // fixed: PandaFM's downloads may use up to this
  reserveGb: number // available: leave at least this much free on the storage
}

export interface Budget {
  mode: BudgetSettings['storageMode']
  usedBytes: number // downloaded songs (each song once, however many downloads share it)
  pendingBytes: number // queued and downloading
  freeBytes: number | null // free on the chosen storage, as the device reports it
  limitBytes: number | null
  reserveBytes: number | null
  remainingBytes: number | null // what may still be added; null when free space is unknown
  overLimit: boolean // e.g. after lowering the limit: nothing is deleted, nothing new is added
}

export function budgetOf({ usedBytes, pendingBytes = 0, freeBytes }: { usedBytes: number; pendingBytes?: number; freeBytes: number | null }, s: BudgetSettings): Budget {
  const committed = usedBytes + pendingBytes
  if (s.storageMode === 'fixed') {
    const limit = Math.max(0, s.storageLimitGb) * GB
    let remaining = limit - committed
    if (freeBytes != null) remaining = Math.min(remaining, freeBytes - pendingBytes) // and the storage can't go below empty
    return { mode: 'fixed', usedBytes, pendingBytes, freeBytes, limitBytes: limit, reserveBytes: null, remainingBytes: Math.max(0, remaining), overLimit: usedBytes > limit }
  }
  const reserve = Math.max(0, s.reserveGb) * GB
  if (freeBytes == null) {
    return { mode: 'available', usedBytes, pendingBytes, freeBytes, limitBytes: null, reserveBytes: reserve, remainingBytes: null, overLimit: false }
  }
  return {
    mode: 'available', usedBytes, pendingBytes, freeBytes, limitBytes: null, reserveBytes: reserve,
    remainingBytes: Math.max(0, freeBytes - pendingBytes - reserve), overLimit: freeBytes < reserve,
  }
}

export function formatSize(bytes: number): string {
  return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** May a download needing `neededBytes` start? */
export function checkFits(b: Budget, neededBytes: number): { ok: boolean; message: string | null } {
  if (neededBytes <= 0 || b.remainingBytes === null) return { ok: true, message: null } // nothing new, or free space unknown
  if (neededBytes <= b.remainingBytes) return { ok: true, message: null }
  if (b.overLimit) {
    return { ok: false, message: 'PandaFM is over this device’s storage limit. Remove some downloads or raise the limit in Settings › Offline storage.' }
  }
  return {
    ok: false,
    message: `This download needs about ${formatSize(neededBytes)}, but PandaFM only has ${formatSize(b.remainingBytes)} available under this device’s storage limit.`,
  }
}
