import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Track } from '../api/library'
import type { NativeJob } from '../platform/native'
import { budgetOf, checkFits, GB } from './budget.ts'
import { BudgetError, DownloadManager } from './manager.ts'
import { DEFAULT_SETTINGS, type OfflineSettings } from './settings.ts'
import { MemoryManifestStore } from './store.ts'
import type { Manifest, ManifestItem } from './types'

const fixed = (gb: number) => ({ storageMode: 'fixed' as const, storageLimitGb: gb, reserveGb: 0 })
const available = (reserveGb: number) => ({ storageMode: 'available' as const, storageLimitGb: 64, reserveGb })

describe('storage budget', () => {
  it('a fixed limit allows what fits and refuses what doesn’t', () => {
    const b = budgetOf({ usedBytes: 50 * GB, freeBytes: 400 * GB }, fixed(64))
    assert.equal(b.remainingBytes, 14 * GB)
    assert.deepEqual(checkFits(b, 10 * GB), { ok: true, message: null })
    const no = checkFits(b, 20 * GB)
    assert.equal(no.ok, false)
    assert.equal(no.message, 'This download needs about 20.0 GB, but PandaFM only has 14.0 GB available under this device’s storage limit.')
  })

  it('a fixed limit can’t promise more than the storage has', () => {
    assert.equal(budgetOf({ usedBytes: 0, freeBytes: 3 * GB }, fixed(64)).remainingBytes, 3 * GB)
  })

  it('“use available space” keeps the reserve free', () => {
    const b = budgetOf({ usedBytes: 184 * GB, freeBytes: 327 * GB }, available(5))
    assert.equal(b.remainingBytes, 322 * GB)
    assert.equal(checkFits(b, 300 * GB).ok, true)
    assert.equal(checkFits(b, 323 * GB).ok, false) // would eat into the 5 GB reserve
  })

  it('downloads already queued count, so parallel requests can’t overcommit', () => {
    assert.equal(budgetOf({ usedBytes: 0, pendingBytes: 10 * GB, freeBytes: 20 * GB }, available(5)).remainingBytes, 5 * GB)
    assert.equal(budgetOf({ usedBytes: 20 * GB, pendingBytes: 10 * GB, freeBytes: 100 * GB }, fixed(32)).remainingBytes, 2 * GB)
  })

  it('over the limit (after lowering it): nothing new, with a clear reason', () => {
    const b = budgetOf({ usedBytes: 40 * GB, freeBytes: 100 * GB }, fixed(32))
    assert.equal(b.overLimit, true)
    assert.match(checkFits(b, GB).message ?? '', /over this device’s storage limit/)
  })

  it('unknown free space doesn’t block (only a fixed limit can be checked then)', () => {
    assert.equal(budgetOf({ usedBytes: 0, freeBytes: null }, available(5)).remainingBytes, null)
    assert.equal(checkFits(budgetOf({ usedBytes: 0, freeBytes: null }, available(5)), 900 * GB).ok, true)
    assert.equal(checkFits(budgetOf({ usedBytes: 0, freeBytes: null }, fixed(32)), 33 * GB).ok, false)
  })
})

// ── The download manager with a budget ──

const track = (id: string): Track => ({
  id, title: id, artist: 'A', artist_id: 'ar', album: 'Al', album_id: 'al', cover_art_id: null, duration_seconds: 200, track_number: 1,
  disc_number: null, year: null, genres: [], content_type: 'audio/flac', suffix: 'flac', bitrate_kbps: 900, favorite: false,
})
const item = (id: string, gb: number): ManifestItem => ({
  track: track(id), plan: { profile: 'original', action: 'original', extension: 'flac', codec: 'flac', lossless: true, bitrate_kbps: 900, estimated_bytes: gb * GB, exact_size: true, note: null },
  relative_path: `Music/A/Al/${id}.flac`, url: `/api/downloads/files/${id}/original`, source_revision: 'r1', size_bytes: gb * GB, sha256: null, status: 'ready',
})
const manifest = (kind: string, id: string, items: ManifestItem[]): Manifest => ({ kind, id, name: id, profile: 'original', duration_seconds: 600, items, estimates: [] })

function setup(settings: Partial<OfflineSettings>, freeGb: number | null) {
  const queued: NativeJob[] = []
  const deleted: string[] = []
  const manifests: Record<string, Manifest> = {}
  let current: OfflineSettings = { ...DEFAULT_SETTINGS, ...settings }
  let free = freeGb == null ? null : freeGb * GB
  const manager = new DownloadManager({
    prepare: async (req) => manifests[req.id ?? req.kind],
    store: new MemoryManifestStore(),
    native: {
      enqueue: async ({ jobs }) => { queued.push(...jobs) },
      acknowledge: async () => {}, deleteFile: async ({ uri }) => { deleted.push(uri); return { deleted: true } },
      getJobs: async () => ({ jobs: [] }), cancel: async () => {}, pause: async () => {}, resume: async () => {},
    },
    absoluteUrl: (p) => p,
    settings: () => current,
    freeSpace: async () => free,
    setTimer: () => 0,
  })
  const finish = async (id: string) => {
    const size = manager.state.getState().tracks[id].expectedBytes ?? 0
    if (free != null) free -= size // the file now takes real space
    await manager.onJob({ id, status: 'done', bytes: size, total: size, uri: `content://sd/${id}` })
  }
  return { manager, queued, deleted, manifests, finish, set: (s: Partial<OfflineSettings>) => { current = { ...current, ...s } } }
}

describe('downloads under a storage budget', () => {
  it('album and playlist downloads still work, and refuse what doesn’t fit', async () => {
    const t = setup({ storageMode: 'fixed', storageLimitGb: 10 }, 500)
    t.manifests.al1 = manifest('album', 'al1', [item('a1', 2), item('a2', 2), item('a3', 2)])
    t.manifests.mix = manifest('playlist', 'mix', [item('p1', 2), item('p2', 2), item('p3', 2)])
    await t.manager.download({ kind: 'album', id: 'al1' }, 'original', true)
    assert.deepEqual(t.queued.map((j) => j.id), ['a1', 'a2', 'a3'])
    await assert.rejects(t.manager.download({ kind: 'playlist', id: 'mix' }, 'original', true), (err: Error) =>
      err instanceof BudgetError && err.message === 'This download needs about 6.0 GB, but PandaFM only has 4.0 GB available under this device’s storage limit.')
    assert.equal(t.queued.length, 3) // nothing new started
    assert.equal(t.manager.state.getState().collections['playlist:mix'], undefined)
    for (const id of ['a1', 'a2', 'a3']) await t.finish(id)
    assert.equal(t.manager.state.getState().tracks.a2.status, 'downloaded')
  })

  it('“use available space” fills the card until the reserve', async () => {
    const t = setup({ storageMode: 'available', reserveGb: 5 }, 20)
    t.manifests.big = manifest('album', 'big', [item('b1', 4), item('b2', 4), item('b3', 4)])
    t.manifests.more = manifest('album', 'more', [item('m1', 4), item('m2', 4)])
    await t.manager.download({ kind: 'album', id: 'big' }, 'original', false) // 12 of 15 GB allowed
    await assert.rejects(t.manager.download({ kind: 'album', id: 'more' }, 'original', false), BudgetError) // 8 more would eat the reserve
    assert.equal(t.queued.length, 3)
  })

  it('lowering the limit deletes nothing and blocks new downloads', async () => {
    const t = setup({ storageMode: 'fixed', storageLimitGb: 10 }, 500)
    t.manifests.al1 = manifest('album', 'al1', [item('a1', 2), item('a2', 2), item('a3', 2)])
    t.manifests.tracks = manifest('tracks', 'one', [item('x1', 1)])
    await t.manager.download({ kind: 'album', id: 'al1' }, 'original', true)
    for (const id of ['a1', 'a2', 'a3']) await t.finish(id)
    t.set({ storageLimitGb: 4 })
    const budget = await t.manager.budget()
    assert.equal(budget.overLimit, true)
    assert.deepEqual(t.deleted, [])
    assert.equal(Object.values(t.manager.state.getState().tracks).filter((x) => x.status === 'downloaded').length, 3)
    await assert.rejects(t.manager.download({ kind: 'track', id: 'one' }, 'original', false), /over this device’s storage limit/)
  })

  it('a song in two downloaded playlists counts once', async () => {
    const t = setup({ storageMode: 'fixed', storageLimitGb: 6 }, 500)
    t.manifests.a = manifest('playlist', 'a', [item('s1', 2), item('s2', 2)])
    t.manifests.b = manifest('playlist', 'b', [item('s2', 2), item('s3', 2)])
    await t.manager.download({ kind: 'playlist', id: 'a' }, 'original', true)
    for (const id of ['s1', 's2']) await t.finish(id)
    await t.manager.download({ kind: 'playlist', id: 'b' }, 'original', true) // needs only s3: 4 + 2 = 6 GB
    await t.finish('s3')
    assert.equal((await t.manager.budget()).usedBytes, 6 * GB)
    assert.deepEqual(t.manager.state.getState().tracks.s2.refs, ['playlist:a', 'playlist:b'])
  })

  it('auto-sync honours the limit: removals happen, additions wait, nothing throws', async () => {
    const t = setup({ storageMode: 'fixed', storageLimitGb: 6 }, 500)
    t.manifests.mix = manifest('playlist', 'mix', [item('s1', 2), item('s2', 2)])
    await t.manager.download({ kind: 'playlist', id: 'mix' }, 'original', true)
    for (const id of ['s1', 's2']) await t.finish(id)
    t.manifests.mix = manifest('playlist', 'mix', [item('s2', 2), item('n1', 3), item('n2', 3)]) // -s1, +6 GB
    await t.manager.syncAll()
    assert.deepEqual(t.deleted, ['content://sd/s1']) // the removal still frees space
    assert.ok(!t.queued.some((j) => j.id.startsWith('n')))
    assert.match(t.manager.state.getState().budgetNotice ?? '', /needs about 6.0 GB/)
    assert.deepEqual(t.manager.state.getState().collections['playlist:mix'].trackIds, ['s2', 'n1', 'n2']) // follows the server; adds when there is room
  })
})
