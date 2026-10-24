import { createStore, type StoreApi } from 'zustand/vanilla'
import type { NativeJobState, PandaStoragePlugin } from '../platform/native'
import { planCollection, release } from './planner.ts'
import type { OfflineSettings } from './settings'
import type { ManifestStore } from './store'
import { type CollectionKind, collectionKey, type Manifest, type ManifestItem, type OfflineCollection, type OfflineTrack } from './types.ts'

// The download manager: plans what to fetch, hands the work to the native
// background queue (which survives the app being in the background), checks
// every finished file, retries what failed, and keeps the manifest true.

export const MAX_ATTEMPTS = 5
const RETRY_BASE_MS = 30_000

export interface PrepareRequest {
  kind: 'tracks' | 'album' | 'playlist' | 'favorites'
  id?: string | null
  track_ids?: string[]
  profile: string
  warm?: boolean
}

type Native = Pick<PandaStoragePlugin, 'enqueue' | 'acknowledge' | 'deleteFile' | 'getJobs' | 'cancel' | 'pause' | 'resume'>

export interface ManagerDeps {
  prepare: (request: PrepareRequest) => Promise<Manifest>
  store: ManifestStore
  native: Native
  absoluteUrl: (path: string) => string
  settings: () => OfflineSettings
  setTimer?: (fn: () => void, ms: number) => unknown
}

export interface OfflineState {
  ready: boolean
  tracks: Record<string, OfflineTrack>
  collections: Record<string, OfflineCollection>
  artwork: Record<string, string>
  progress: Record<string, { bytes: number; total: number | null }>
  paused: boolean
}

const MIME: Record<string, string> = { flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav' }

export class DownloadManager {
  readonly state: StoreApi<OfflineState> = createStore<OfflineState>()(() => ({ ready: false, tracks: {}, collections: {}, artwork: {}, progress: {}, paused: false }))
  private deps: ManagerDeps
  private retryAt = new Map<string, number>()

  constructor(deps: ManagerDeps) {
    this.deps = deps
  }

  private local(): Map<string, OfflineTrack> {
    return new Map(Object.entries(this.state.getState().tracks))
  }

  private async saveTrack(t: OfflineTrack) {
    await this.deps.store.putTrack(t)
    this.state.setState((s) => ({ tracks: { ...s.tracks, [t.trackId]: t } }))
  }

  private async dropTrack(id: string) {
    await this.deps.store.deleteTrack(id)
    this.state.setState((s) => {
      const { [id]: _gone, ...tracks } = s.tracks
      return { tracks }
    })
  }

  /** Load the manifest, then catch up with downloads that finished while the app was closed. */
  async init(): Promise<void> {
    const [tracks, collections, artwork] = await Promise.all([this.deps.store.tracks(), this.deps.store.collections(), this.deps.store.artwork()])
    this.state.setState({
      ready: true,
      tracks: Object.fromEntries(tracks.map((t) => [t.trackId, t])),
      collections: Object.fromEntries(collections.map((c) => [c.key, c])),
      artwork,
    })
    const { jobs } = await this.deps.native.getJobs()
    for (const job of jobs) await this.onJob(job)
  }

  /** Download a song, album, playlist or Favorites (optionally keeping it in sync). */
  async download(target: { kind: CollectionKind; id: string | null; name?: string }, profile: string, keepSynced: boolean): Promise<OfflineCollection> {
    const manifest = await this.deps.prepare({
      kind: target.kind === 'track' ? 'tracks' : target.kind,
      id: target.kind === 'track' ? null : target.id,
      track_ids: target.kind === 'track' && target.id ? [target.id] : [],
      profile,
      warm: true,
    })
    const key = collectionKey(target.kind, target.id)
    const previous = this.state.getState().collections[key]
    const collection: OfflineCollection = {
      key, kind: target.kind, id: target.id, name: manifest.name, profile, keepSynced,
      trackIds: manifest.items.map((i) => i.track.id), coverArtId: manifest.items[0]?.track.cover_art_id ?? null,
      durationSeconds: manifest.duration_seconds, updatedAt: new Date().toISOString(),
    }
    await this.deps.store.putCollection(collection)
    this.state.setState((s) => ({ collections: { ...s.collections, [key]: collection } }))
    await this.apply(collection, manifest, previous?.trackIds ?? [])
    return collection
  }

  /** Re-check a collection against the server: new songs come, removed songs go (if unused elsewhere). */
  async sync(key: string): Promise<void> {
    const c = this.state.getState().collections[key]
    if (!c) return
    await this.download({ kind: c.kind, id: c.id, name: c.name }, c.profile, c.keepSynced)
  }

  async syncAll(): Promise<void> {
    for (const c of Object.values(this.state.getState().collections)) {
      if (c.keepSynced) await this.sync(c.key)
    }
  }

  private async apply(collection: OfflineCollection, manifest: Manifest, previous: string[]) {
    const plan = planCollection(previous, manifest, this.local())
    const key = collection.key
    for (const id of plan.link) {
      const entry = this.state.getState().tracks[id]
      if (entry && !entry.refs.includes(key)) await this.saveTrack({ ...entry, refs: [...entry.refs, key] })
    }
    const queue: ManifestItem[] = [...plan.download, ...plan.refresh]
    for (const item of plan.download) {
      const old = this.state.getState().tracks[item.track.id]
      await this.saveTrack(this.entryFor(item, [...new Set([...(old?.refs ?? []), key])]))
    }
    for (const item of plan.refresh) {
      const entry = this.state.getState().tracks[item.track.id]
      await this.saveTrack({ ...entry, status: 'outdated' }) // keeps playing the old copy until the new one is verified
    }
    await this.enqueue(queue)
    if (plan.unref.length) await this.releaseFrom(key, plan.unref)
  }

  private entryFor(item: ManifestItem, refs: string[]): OfflineTrack {
    return {
      trackId: item.track.id, track: item.track, profile: item.plan.profile, relativePath: item.relative_path, localUri: null,
      sizeBytes: item.size_bytes, sha256: item.sha256, sourceRevision: item.source_revision, codec: item.plan.codec,
      lossless: item.plan.lossless, qualityBadge: item.track.quality?.badge ?? null, qualityDetail: item.track.quality?.detail ?? null,
      bitrateKbps: item.plan.bitrate_kbps, status: 'queued', attempts: 0, error: null, downloadedAt: null, refs,
    }
  }

  private pendingItems = new Map<string, ManifestItem>()

  private async enqueue(items: ManifestItem[]) {
    if (!items.length) return
    for (const item of items) this.pendingItems.set(item.track.id, item)
    const settings = this.deps.settings()
    await this.deps.native.enqueue({
      concurrency: settings.concurrency,
      allowMetered: settings.syncPolicy === 'any',
      jobs: items.map((item) => ({
        id: item.track.id, // one job per song: the native queue ignores duplicates
        url: this.deps.absoluteUrl(item.url),
        relativePath: item.relative_path,
        expectedBytes: item.size_bytes,
        sha256: item.sha256,
        mimeType: MIME[item.plan.extension] ?? 'application/octet-stream',
      })),
    })
  }

  /** Native queue updates: progress, finished files (checked here), failures (retried). */
  async onJob(job: NativeJobState): Promise<void> {
    const entry = this.state.getState().tracks[job.id]
    if (!entry) {
      await this.deps.native.acknowledge({ ids: [job.id] })
      return
    }
    if (job.status === 'running' || job.status === 'queued' || job.status === 'paused') {
      this.state.setState((s) => ({ progress: { ...s.progress, [job.id]: { bytes: job.bytes, total: job.total } } }))
      if (entry.status === 'queued' && job.status === 'running') await this.saveTrack({ ...entry, status: 'downloading' })
      return
    }
    this.state.setState((s) => {
      const { [job.id]: _done, ...progress } = s.progress
      return { progress }
    })
    await this.deps.native.acknowledge({ ids: [job.id] })
    const item = this.pendingItems.get(job.id)
    const expectedSize = item?.size_bytes ?? entry.sizeBytes
    const expectedHash = item?.sha256 ?? entry.sha256
    if (job.status === 'done' && job.uri) {
      const badSize = expectedSize != null && job.bytes !== expectedSize
      const badHash = !!expectedHash && !!job.sha256 && job.sha256 !== expectedHash
      if (!badSize && !badHash) {
        this.pendingItems.delete(job.id)
        const fresh = item ? this.entryFor(item, entry.refs) : entry
        await this.saveTrack({ ...fresh, localUri: job.uri, sizeBytes: job.bytes, sha256: job.sha256 ?? expectedHash ?? null, status: 'downloaded', error: null, downloadedAt: new Date().toISOString(), attempts: entry.attempts })
        return
      }
      await this.deps.native.deleteFile({ uri: job.uri })
      return this.fail(entry, badSize ? `Incomplete file (${job.bytes} of ${expectedSize} bytes)` : 'Checksum mismatch', true)
    }
    return this.fail(entry, job.error ?? 'Download failed', job.retryable !== false)
  }

  private async fail(entry: OfflineTrack, error: string, retryable: boolean) {
    const attempts = entry.attempts + 1
    const keepOld = entry.status === 'outdated' && entry.localUri // a failed refresh keeps the old copy
    await this.saveTrack({ ...entry, attempts, error, status: keepOld ? 'outdated' : 'failed' })
    const item = this.pendingItems.get(entry.trackId)
    if (retryable && attempts < MAX_ATTEMPTS && item) {
      const wait = RETRY_BASE_MS * attempts
      this.retryAt.set(entry.trackId, Date.now() + wait)
      ;(this.deps.setTimer ?? setTimeout)(() => void this.retry(entry.trackId), wait)
    }
  }

  async retry(trackId: string): Promise<void> {
    const item = this.pendingItems.get(trackId)
    const entry = this.state.getState().tracks[trackId]
    if (!item || !entry) return
    if (entry.status === 'failed') await this.saveTrack({ ...entry, status: 'queued' })
    await this.enqueue([item])
  }

  async retryFailed(): Promise<void> {
    for (const t of Object.values(this.state.getState().tracks)) {
      if (t.status === 'failed') {
        if (this.pendingItems.has(t.trackId)) await this.retry(t.trackId)
        else for (const ref of t.refs) await this.sync(ref)
      }
    }
  }

  /** Remove a collection's download. Songs still used by another download stay. */
  async removeCollection(key: string): Promise<void> {
    const c = this.state.getState().collections[key]
    if (!c) return
    await this.releaseFrom(key, c.trackIds)
    await this.deps.store.deleteCollection(key)
    this.state.setState((s) => {
      const { [key]: _gone, ...collections } = s.collections
      return { collections }
    })
  }

  /** Delete one song's file from this device. Server, favorites, playlists and history are untouched. */
  async removeTrack(trackId: string): Promise<void> {
    const entry = this.state.getState().tracks[trackId]
    if (!entry) return
    await this.deps.native.cancel({ ids: [trackId] })
    if (entry.localUri) await this.deps.native.deleteFile({ uri: entry.localUri })
    this.pendingItems.delete(trackId)
    await this.dropTrack(trackId)
  }

  private async releaseFrom(key: string, trackIds: string[]) {
    const { updated, orphans } = release(this.local(), key, trackIds)
    for (const t of updated) await this.saveTrack(t)
    for (const t of orphans) await this.removeTrack(t.trackId)
  }

  pause = async () => {
    await this.deps.native.pause()
    this.state.setState({ paused: true })
  }

  resume = async () => {
    await this.deps.native.resume()
    this.state.setState({ paused: false })
  }

  async rememberArtwork(coverArtId: string, uri: string) {
    await this.deps.store.putArtwork(coverArtId, uri)
    this.state.setState((s) => ({ artwork: { ...s.artwork, [coverArtId]: uri } }))
  }
}

/** Progress of one collection, from the manifest and the live native updates. */
export function collectionProgress(state: OfflineState, key: string) {
  const c = state.collections[key]
  if (!c) return null
  let done = 0
  let failed = 0
  let bytesDone = 0
  let bytesTotal = 0
  let current: string | null = null
  for (const id of c.trackIds) {
    const t = state.tracks[id]
    const live = state.progress[id]
    if (!t) continue
    if (t.status === 'downloaded') done++
    if (t.status === 'failed') failed++
    bytesTotal += t.sizeBytes ?? live?.total ?? 0
    bytesDone += t.status === 'downloaded' ? (t.sizeBytes ?? 0) : (live?.bytes ?? 0)
    if (!current && t.status === 'downloading') current = `${t.track.artist} — ${t.track.title}`
  }
  return { total: c.trackIds.length, done, failed, bytesDone, bytesTotal, current }
}
