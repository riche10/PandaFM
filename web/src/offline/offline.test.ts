import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import type { Track } from '../api/library'
import type { NativeJob, NativeJobState } from '../platform/native'
import { DownloadManager, collectionProgress } from './manager.ts'
import { createSourceResolver } from './playback.ts'
import { planCollection, release } from './planner.ts'
import { DEFAULT_SETTINGS } from './settings.ts'
import { MemoryManifestStore } from './store.ts'
import type { Manifest, ManifestItem, OfflineTrack } from './types'

const track = (id: string): Track => ({
  id, title: `Song ${id}`, artist: 'Neon Panda', artist_id: 'ar1', album: 'Drive', album_id: 'al1', cover_art_id: 'al-1',
  duration_seconds: 200, track_number: 1, disc_number: null, year: 1986, genres: [], content_type: 'audio/flac', suffix: 'flac',
  bitrate_kbps: 900, favorite: false, album_artist: null, sample_rate: 44100, bit_depth: 16, channels: 2, size_bytes: 1000,
  quality: { codec: 'FLAC', lossless: true, hi_res: false, badge: 'LOSSLESS', detail: '16-bit / 44.1 kHz', short: '16/44.1', bitrate_kbps: 900 },
})

const item = (id: string, revision = 'r1'): ManifestItem => ({
  track: track(id),
  plan: { profile: 'original', action: 'original', extension: 'flac', codec: 'flac', lossless: true, bitrate_kbps: 900, estimated_bytes: 1000, exact_size: true, note: null },
  relative_path: `Music/Neon Panda/Drive/${id}.flac`, url: `/api/downloads/files/${id}/original`, source_revision: revision, size_bytes: 1000, sha256: null, status: 'ready',
})

const manifest = (name: string, items: ManifestItem[]): Manifest => ({ kind: 'playlist', id: name, name, profile: 'original', duration_seconds: 600, items, estimates: [] })

class FakeNative {
  queued: NativeJob[] = []
  deleted: string[] = []
  acknowledged: string[] = []
  pending: NativeJobState[] = []
  async enqueue({ jobs }: { jobs: NativeJob[] }) { for (const j of jobs) if (!this.queued.some((q) => q.id === j.id)) this.queued.push(j) }
  async acknowledge({ ids }: { ids: string[] }) { this.acknowledged.push(...ids); this.queued = this.queued.filter((q) => !ids.includes(q.id)) }
  async deleteFile({ uri }: { uri: string }) { this.deleted.push(uri); return { deleted: true } }
  async getJobs() { return { jobs: this.pending } }
  async cancel() {}
  async pause() {}
  async resume() {}
}

let native: FakeNative
let manifests: Record<string, Manifest>
let timers: (() => void)[]

function setup() {
  native = new FakeNative()
  timers = []
  const store = new MemoryManifestStore()
  const manager = new DownloadManager({
    prepare: async (req) => manifests[req.id ?? req.kind],
    store,
    native,
    absoluteUrl: (p) => `https://fm.example${p}`,
    settings: () => DEFAULT_SETTINGS,
    setTimer: (fn) => timers.push(fn),
  })
  return { manager, store }
}

const finish = (m: DownloadManager, id: string, bytes = 1000) => m.onJob({ id, status: 'done', bytes, total: bytes, uri: `content://sd/${id}` })

beforeEach(() => {
  manifests = { mixA: manifest('mixA', [item('t1'), item('t2')]), mixB: manifest('mixB', [item('t2'), item('t3')]) }
})

describe('planning', () => {
  it('downloads new songs, links known ones, refreshes changed ones and releases removed ones', () => {
    const local = new Map<string, OfflineTrack>([
      ['t1', { trackId: 't1', status: 'downloaded', localUri: 'u1', sourceRevision: 'r1', refs: ['playlist:mixA'] } as OfflineTrack],
      ['t2', { trackId: 't2', status: 'downloaded', localUri: 'u2', sourceRevision: 'old', refs: ['playlist:mixA'] } as OfflineTrack],
    ])
    const plan = planCollection(['t1', 't2', 'gone'], manifest('mixA', [item('t1'), item('t2'), item('t9')]), local)
    assert.deepEqual(plan.download.map((i) => i.track.id), ['t9'])
    assert.deepEqual(plan.link, ['t1', 't2'])
    assert.deepEqual(plan.refresh.map((i) => i.track.id), ['t2'])
    assert.deepEqual(plan.unref, ['gone'])
  })

  it('a song another collection still uses is not an orphan', () => {
    const local = new Map<string, OfflineTrack>([
      ['t1', { trackId: 't1', refs: ['playlist:a'] } as OfflineTrack],
      ['t2', { trackId: 't2', refs: ['playlist:a', 'album:x'] } as OfflineTrack],
    ])
    const { updated, orphans } = release(local, 'playlist:a', ['t1', 't2'])
    assert.deepEqual(orphans.map((t) => t.trackId), ['t1'])
    assert.deepEqual(updated[0].refs, ['album:x'])
  })
})

describe('download manager', () => {
  it('queues each song once, with absolute URLs, even across collections', async () => {
    const { manager } = setup()
    await manager.download({ kind: 'playlist', id: 'mixA' }, 'original', true)
    await manager.download({ kind: 'playlist', id: 'mixB' }, 'original', true)
    assert.deepEqual(native.queued.map((j) => j.id), ['t1', 't2', 't3'])
    assert.equal(native.queued[0].url, 'https://fm.example/api/downloads/files/t1/original')
    assert.deepEqual(manager.state.getState().tracks.t2.refs, ['playlist:mixA', 'playlist:mixB'])
  })

  it('marks a song downloaded only after its size checks out; a short file is retried', async () => {
    const { manager, store } = setup()
    await manager.download({ kind: 'playlist', id: 'mixA' }, 'original', false)
    await finish(manager, 't1')
    await finish(manager, 't2', 600) // incomplete
    const tracks = manager.state.getState().tracks
    assert.equal(tracks.t1.status, 'downloaded')
    assert.equal(tracks.t1.localUri, 'content://sd/t1')
    assert.equal(tracks.t2.status, 'failed')
    assert.deepEqual(native.deleted, ['content://sd/t2'])
    assert.equal(timers.length, 1)
    timers[0]()
    await new Promise((r) => setTimeout(r, 0))
    assert.ok(native.queued.some((j) => j.id === 't2'), 'retried')
    assert.equal((await store.tracks()).find((t) => t.trackId === 't1')?.status, 'downloaded') // persisted
  })

  it('removing one playlist keeps songs another downloaded playlist still needs', async () => {
    const { manager } = setup()
    await manager.download({ kind: 'playlist', id: 'mixA' }, 'original', true)
    await manager.download({ kind: 'playlist', id: 'mixB' }, 'original', true)
    for (const id of ['t1', 't2', 't3']) await finish(manager, id)
    await manager.removeCollection('playlist:mixA')
    assert.deepEqual(native.deleted, ['content://sd/t1'])
    const tracks = manager.state.getState().tracks
    assert.equal(tracks.t1, undefined)
    assert.deepEqual(tracks.t2.refs, ['playlist:mixB'])
  })

  it('remove download deletes only the device copy', async () => {
    const { manager } = setup()
    await manager.download({ kind: 'playlist', id: 'mixA' }, 'original', true)
    await finish(manager, 't1')
    await manager.removeTrack('t1')
    assert.deepEqual(native.deleted, ['content://sd/t1'])
    assert.equal(manager.state.getState().tracks.t1, undefined)
    assert.deepEqual(manager.state.getState().collections['playlist:mixA'].trackIds, ['t1', 't2']) // the playlist itself is untouched
  })

  it('syncing a changed playlist downloads additions and releases removals', async () => {
    const { manager } = setup()
    await manager.download({ kind: 'playlist', id: 'mixA' }, 'original', true)
    for (const id of ['t1', 't2']) await finish(manager, id)
    manifests.mixA = manifest('mixA', [item('t2'), item('t4')]) // server: -t1, +t4
    await manager.sync('playlist:mixA')
    assert.ok(native.queued.some((j) => j.id === 't4'))
    assert.deepEqual(native.deleted, ['content://sd/t1'])
    assert.deepEqual(manager.state.getState().collections['playlist:mixA'].trackIds, ['t2', 't4'])
  })

  it('a changed library file is refreshed while the old copy keeps playing', async () => {
    const { manager } = setup()
    await manager.download({ kind: 'playlist', id: 'mixA' }, 'original', true)
    await finish(manager, 't1')
    manifests.mixA = manifest('mixA', [item('t1', 'r2'), item('t2')])
    await manager.sync('playlist:mixA')
    assert.equal(manager.state.getState().tracks.t1.status, 'outdated')
    assert.equal(manager.state.getState().tracks.t1.localUri, 'content://sd/t1')
    await finish(manager, 't1')
    assert.equal(manager.state.getState().tracks.t1.sourceRevision, 'r2')
    assert.equal(manager.state.getState().tracks.t1.status, 'downloaded')
  })

  it('catches up with downloads that finished while the app was closed', async () => {
    const { manager, store } = setup()
    await manager.download({ kind: 'playlist', id: 'mixA' }, 'original', false)
    const restarted = new DownloadManager({ prepare: async () => manifests.mixA, store, native, absoluteUrl: (p) => p, settings: () => DEFAULT_SETTINGS })
    native.pending = [{ id: 't1', status: 'done', bytes: 1000, total: 1000, uri: 'content://sd/t1' }]
    await restarted.init()
    assert.equal(restarted.state.getState().tracks.t1.status, 'downloaded')
    assert.equal(collectionProgress(restarted.state.getState(), 'playlist:mixA')?.done, 1)
  })
})

describe('playback source', () => {
  const entry = { trackId: 't1', status: 'downloaded', localUri: 'content://sd/t1' } as OfflineTrack
  const resolver = (online: boolean, local?: OfflineTrack, settings = DEFAULT_SETTINGS) =>
    createSourceResolver({ track: () => local, settings: () => settings, online: () => online, localFileUrl: (u) => `local:${u}`, streamUrl: (id) => `stream:${id}` })

  it('plays the downloaded file, streams otherwise, and says when neither is possible', () => {
    assert.equal(resolver(true, entry)('t1'), 'local:content://sd/t1')
    assert.equal(resolver(true)('t1'), 'stream:t1')
    assert.equal(resolver(false)('t1'), null)
    assert.equal(resolver(false, entry, { ...DEFAULT_SETTINGS, preferLocal: false })('t1'), 'local:content://sd/t1')
    assert.equal(resolver(true, entry, { ...DEFAULT_SETTINGS, preferLocal: false })('t1'), 'stream:t1')
  })
})
