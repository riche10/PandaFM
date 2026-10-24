import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Track } from '../api/library'
import type { NativePlayerEvent, NativeRemoteCommand, PandaPlayerPlugin } from '../platform/native'
import { createSourceResolver } from '../offline/playback.ts'
import { DEFAULT_SETTINGS } from '../offline/settings.ts'
import { createAutoplay, DEFAULT_AUTOPLAY } from './autoplay.ts'
import { AudioEngine } from './engine.ts'
import { createPlaybackEngine, usesBrowserMediaSession } from './engineSelect.ts'
import { NATIVE_ERROR_MESSAGES, NativePlaybackEngine } from './nativeEngine.ts'
import { createPlayerStore, type PlaybackReport } from './store.ts'

const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id, title: `Song ${id}`, artist: 'Bring Me the Horizon', artist_id: 'ar', album: 'POST HUMAN', album_id: 'al', cover_art_id: `mf-${id}`,
  duration_seconds: 200, track_number: 1, disc_number: null, year: null, genres: [], content_type: 'audio/flac', suffix: 'flac',
  bitrate_kbps: 1085, favorite: false, ...extra,
})

class FakePlugin implements PandaPlayerPlugin {
  calls: { method: string; args: unknown }[] = []
  state = new Set<(e: NativePlayerEvent) => void>()
  remote = new Set<(c: NativeRemoteCommand) => void>()
  private record(method: string, args?: unknown) { this.calls.push({ method, args }); return Promise.resolve() }
  load(o: Parameters<PandaPlayerPlugin['load']>[0]) { return this.record('load', o) }
  play(o: { gen: number }) { return this.record('play', o) }
  pause() { return this.record('pause') }
  seek(o: { position: number }) { return this.record('seek', o) }
  stop() { return this.record('stop') }
  setVolume(o: { volume: number }) { return this.record('setVolume', o) }
  getState() { return Promise.resolve({ engine: 'Media3 ExoPlayer 1.11.1', isPlaying: false, position: 0, duration: null, uriScheme: null, mediaId: null }) }
  addListener(event: 'state' | 'remote', listener: never) {
    ;(event === 'state' ? this.state : this.remote).add(listener)
    return Promise.resolve({ remove: async () => undefined })
  }
  emit(e: NativePlayerEvent) { for (const l of this.state) l(e) }
  press(c: NativeRemoteCommand) { for (const l of this.remote) l(c) }
  loads() { return this.calls.filter((c) => c.method === 'load').map((c) => c.args as { gen: number; url: string; title: string; artworkUrl: string | null }) }
}

function nativeSetup() {
  const plugin = new FakePlugin()
  const engine = new NativePlaybackEngine(plugin, { artworkFor: (t) => `https://fm.example/api/covers/${t.cover_art_id}?size=600` })
  const reports: PlaybackReport[] = []
  let ended = 0
  const store = createPlayerStore({ engine, streamUrl: (id) => `https://fm.example/api/tracks/${id}/stream`, explainError: async (_id, _k, m) => m ?? '', report: (e) => reports.push(e), onQueueEnd: () => { ended++ } })
  const gen = () => plugin.loads().at(-1)!.gen
  return { plugin, engine, store, reports, ended: () => ended, gen }
}

describe('platform boundary', () => {
  it('browsers keep <audio>; the Android app uses the native engine; one media session each', () => {
    const g = globalThis as { Audio?: unknown }
    const before = g.Audio
    g.Audio = class { addEventListener() {} removeEventListener() {} pause() {} load() {} removeAttribute() {} setAttribute() {} play() { return Promise.resolve() } }
    try {
      assert.ok(createPlaybackEngine({ kind: 'web', player: null }, { artworkFor: () => null }) instanceof AudioEngine)
      assert.ok(createPlaybackEngine({ kind: 'android', player: null }, { artworkFor: () => null }) instanceof AudioEngine) // no plugin: still plays
    } finally {
      g.Audio = before
    }
    assert.ok(createPlaybackEngine({ kind: 'android', player: new FakePlugin() }, { artworkFor: () => null }) instanceof NativePlaybackEngine)
    assert.equal(usesBrowserMediaSession({ kind: 'web', player: null }), true)
    assert.equal(usesBrowserMediaSession({ kind: 'android', player: new FakePlugin() }), false)
  })

  it('downloaded songs reach the native player as content:// URIs, streams as the server URL', () => {
    const resolve = createSourceResolver({
      track: (id) => (id === 'dl' ? ({ trackId: 'dl', status: 'downloaded', localUri: 'content://com.android.externalstorage.documents/tree/1234-ABCD%3APandaFM/document/x.flac' } as never) : undefined),
      settings: () => DEFAULT_SETTINGS, online: () => true, localFileUrl: (uri) => uri, streamUrl: (id) => `http://192.168.10.65:8086/api/tracks/${id}/stream`,
    })
    const t = nativeSetup()
    t.engine.load(resolve('dl')!, track('dl'))
    t.engine.load(resolve('1uOagxAvF38VNRASsFn2l7')!, track('1uOagxAvF38VNRASsFn2l7'))
    const [local, stream] = t.plugin.loads()
    assert.match(local.url, /^content:\/\//)
    assert.equal(stream.url, 'http://192.168.10.65:8086/api/tracks/1uOagxAvF38VNRASsFn2l7/stream')
    assert.equal(stream.title, 'Song 1uOagxAvF38VNRASsFn2l7')
    assert.equal(stream.artworkUrl, 'https://fm.example/api/covers/mf-1uOagxAvF38VNRASsFn2l7?size=600')
    assert.equal(stream.gen, local.gen + 1)
  })
})

describe('native events through the shared store', () => {
  it('a natural end is play_completed (never a skip), once, and hands over to Autoplay once', () => {
    const t = nativeSetup()
    t.store.getState().playCollection([track('a')], { source: { kind: 'tracks', name: 'x' } })
    t.plugin.emit({ gen: t.gen(), type: 'playing' })
    t.plugin.emit({ gen: t.gen(), type: 'ended' })
    t.plugin.emit({ gen: t.gen(), type: 'ended' }) // Media3 and a position tick can both say so
    assert.deepEqual(t.reports.map((r) => r.type), ['play_started', 'play_completed'])
    assert.equal(t.ended(), 1)
    assert.equal(t.store.getState().status, 'ended')
  })

  it('a duplicate ended can’t skip the next song in the queue', () => {
    const t = nativeSetup()
    t.store.getState().playCollection([track('a'), track('b'), track('c')], { source: { kind: 'album', id: 'al', name: 'x' } })
    const first = t.gen()
    t.plugin.emit({ gen: first, type: 'playing' })
    t.plugin.emit({ gen: first, type: 'ended' })
    t.plugin.emit({ gen: first, type: 'ended' }) // stale now: belongs to song a
    assert.equal(t.store.getState().items[t.store.getState().index].track.id, 'b')
  })

  it('leaving a song early is a skip; stale events from it are ignored', () => {
    const t = nativeSetup()
    t.store.getState().playCollection([track('a'), track('b')], { source: { kind: 'tracks', name: 'x' } })
    const first = t.gen()
    t.plugin.emit({ gen: first, type: 'playing' })
    t.store.getState().next()
    t.plugin.emit({ gen: first, type: 'paused' }) // the old item stopping
    t.plugin.emit({ gen: first, type: 'ended' })
    assert.deepEqual(t.reports.map((r) => `${r.type}:${r.item.track.id}`), ['play_started:a', 'skip:a'])
    assert.equal(t.store.getState().status, 'loading')
  })

  it('pause and resume are recorded once, also when the lock screen pauses', () => {
    const t = nativeSetup()
    const commands: NativeRemoteCommand[] = []
    t.engine.onRemote((c) => commands.push(c))
    t.store.getState().playCollection([track('a')], { source: { kind: 'tracks', name: 'x' } })
    t.plugin.emit({ gen: t.gen(), type: 'playing' })
    t.plugin.press({ action: 'pause' })
    t.store.getState().pause() // what player/index.ts does with the remote command
    t.plugin.emit({ gen: t.gen(), type: 'paused' })
    t.store.getState().pause() // echoes are harmless
    t.store.getState().play()
    t.plugin.emit({ gen: t.gen(), type: 'playing' })
    assert.deepEqual(commands, [{ action: 'pause' }])
    assert.deepEqual(t.reports.map((r) => r.type), ['play_started', 'pause', 'resume'])
  })

  it('native errors read like a music player, not a browser', () => {
    const t = nativeSetup()
    t.store.getState().playCollection([track('a')], { source: { kind: 'tracks', name: 'x' } })
    t.plugin.emit({ gen: t.gen(), type: 'error', kind: 'decode', code: 'ERROR_CODE_DECODING_FAILED' })
    assert.equal(t.store.getState().error, NATIVE_ERROR_MESSAGES.decode)
    t.store.getState().play()
    t.plugin.emit({ gen: t.gen(), type: 'error', kind: 'network', reason: 'connect' })
    assert.equal(t.store.getState().error, 'The PandaFM server could not be reached.')
    assert.ok(!Object.values(NATIVE_ERROR_MESSAGES).some((m) => m.includes('browser')))
  })

  it('a missing download says so without asking the server', async () => {
    const plugin = new FakePlugin()
    const engine = new NativePlaybackEngine(plugin, { artworkFor: () => null })
    let asked = 0
    const store = createPlayerStore({ engine, streamUrl: () => 'content://x/doc/1', explainError: async () => { asked++; return 'server says' } })
    store.getState().playCollection([track('a')], { source: { kind: 'tracks', name: 'x' } })
    plugin.emit({ gen: plugin.loads().at(-1)!.gen, type: 'error', kind: 'missing', reason: 'not_found' })
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(store.getState().error, 'This downloaded file is missing.')
    assert.equal(asked, 0)
  })

  it('Autoplay continues after native completion through the one radio path', async () => {
    const t = nativeSetup()
    const starts: unknown[] = []
    const autoplay = createAutoplay({
      store: t.store, settings: () => DEFAULT_AUTOPLAY, online: () => true,
      radio: { continueWith: async (preset, seed) => { starts.push({ preset, seed }); return true } },
    })
    t.store.getState().playCollection([track('1x1')], { source: { kind: 'tracks', name: 'x' } })
    t.plugin.emit({ gen: t.gen(), type: 'playing' })
    t.plugin.emit({ gen: t.gen(), type: 'ended' })
    await autoplay.onQueueEnd()
    await autoplay.onQueueEnd()
    assert.deepEqual(starts, [{ preset: 'panda', seed: { kind: 'track', id: '1x1' } }])
  })
})
