import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Track } from '../api/library'
import { createPlayerStore, currentTrack, PLAYBACK_ERROR_MESSAGES } from './store.ts'
import type { EngineEvent, PlaybackEngine } from './types'

class FakeEngine implements PlaybackEngine {
  loaded: string[] = []
  seeks: number[] = []
  playCalls = 0
  volumes: number[] = []
  playResult: () => Promise<void> = () => Promise.resolve()
  private listeners = new Set<(event: EngineEvent) => void>()

  load(src: string) {
    this.loaded.push(src)
    this.emit({ type: 'loading' })
  }
  play() {
    this.playCalls += 1
    return this.playResult()
  }
  pause() {
    this.emit({ type: 'paused' })
  }
  seek(seconds: number) {
    this.seeks.push(seconds)
  }
  stop() {}
  setVolume(volume: number) {
    this.volumes.push(volume)
  }
  subscribe(listener: (event: EngineEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: EngineEvent) {
    for (const listener of this.listeners) listener(event)
  }
}

const track = (id: string, duration = 200): Track => ({
  id,
  title: `Song ${id}`,
  artist: 'Neon Panda',
  artist_id: 'ar1',
  album: 'Midnight Drive',
  album_id: 'al1',
  cover_art_id: 'al-1',
  duration_seconds: duration,
  track_number: null,
  disc_number: null,
  year: null,
  genres: [],
  content_type: 'audio/mpeg',
  suffix: 'mp3',
  bitrate_kbps: 192,
  favorite: false,
})

function setup(explain = async () => 'explained') {
  const engine = new FakeEngine()
  const store = createPlayerStore({
    engine,
    streamUrl: (id) => `/api/tracks/${id}/stream`,
    explainError: explain,
  })
  return { engine, store, actions: store.getState() }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('player store', () => {
  it('loads the picked song from the PandaFM stream URL and plays it', () => {
    const { engine, store, actions } = setup()
    actions.playCollection([track('a'), track('b'), track('c')], { startIndex: 1 })

    assert.deepEqual(engine.loaded, ['/api/tracks/b/stream'])
    assert.equal(engine.playCalls, 1)
    assert.equal(currentTrack(store.getState())?.id, 'b')
    assert.equal(store.getState().status, 'loading')

    engine.emit({ type: 'playing' })
    assert.equal(store.getState().status, 'playing')
  })

  it('pauses and resumes', () => {
    const { engine, store, actions } = setup()
    actions.playCollection([track('a')])
    engine.emit({ type: 'playing' })

    actions.togglePlay()
    assert.equal(store.getState().status, 'paused')

    actions.togglePlay()
    assert.equal(engine.playCalls, 2)
    engine.emit({ type: 'playing' })
    assert.equal(store.getState().status, 'playing')
  })

  it('seeks within the song, clamped to its length', () => {
    const { engine, store, actions } = setup()
    actions.playCollection([track('a', 200)])

    actions.seek(120)
    actions.seek(999)
    actions.seek(-5)
    assert.deepEqual(engine.seeks, [120, 200, 0])
    assert.equal(store.getState().position, 0)
  })

  it('moves through the queue with next and previous', () => {
    const { engine, actions } = setup()
    actions.playCollection([track('a'), track('b')])

    actions.next()
    actions.next() // already at the end: nothing happens
    actions.previous()
    assert.deepEqual(engine.loaded, [
      '/api/tracks/a/stream',
      '/api/tracks/b/stream',
      '/api/tracks/a/stream',
    ])
  })

  it('restarts the song when previous is pressed a few seconds in', () => {
    const { engine, actions } = setup()
    actions.playCollection([track('a'), track('b')], { startIndex: 1 })
    engine.emit({ type: 'time', position: 42, duration: 200 })

    actions.previous()
    assert.deepEqual(engine.seeks, [0])
    assert.equal(engine.loaded.length, 1)
  })

  it('advances when a song ends and stops at the end of the queue', () => {
    const { engine, store, actions } = setup()
    actions.playCollection([track('a'), track('b')])

    engine.emit({ type: 'ended' })
    assert.equal(currentTrack(store.getState())?.id, 'b')

    engine.emit({ type: 'ended' })
    assert.equal(store.getState().status, 'ended')

    actions.play() // play again from the top of the last song
    assert.deepEqual(engine.seeks, [0])
  })

  it('ignores a stray pause from the old source while a new song loads', () => {
    const { engine, store, actions } = setup()
    actions.playCollection([track('a'), track('b')])
    engine.emit({ type: 'playing' })

    actions.next()
    engine.emit({ type: 'paused' })
    assert.equal(store.getState().status, 'loading')
  })

  it('shows a generic error, then the explanation for the same song', async () => {
    const { engine, store, actions } = setup(async () => 'That isn’t in your music library.')
    actions.playCollection([track('a')])

    engine.emit({ type: 'error', kind: 'unsupported' })
    assert.equal(store.getState().status, 'error')
    assert.equal(store.getState().error, PLAYBACK_ERROR_MESSAGES.unsupported)

    await flush()
    assert.equal(store.getState().error, 'That isn’t in your music library.')
  })

  it('drops a late explanation once the user has moved on', async () => {
    let finish: (message: string) => void = () => {}
    const { engine, store, actions } = setup(() => new Promise((resolve) => (finish = resolve)))
    actions.playCollection([track('a'), track('b')])
    engine.emit({ type: 'error', kind: 'network' })

    actions.next()
    finish('stale message')
    await flush()
    assert.equal(store.getState().error, null)
  })

  it('treats a blocked autoplay as paused rather than an error', async () => {
    const { engine, store, actions } = setup()
    engine.playResult = () => Promise.reject(new DOMException('needs a tap', 'NotAllowedError'))
    actions.playCollection([track('a')])

    await flush()
    assert.equal(store.getState().status, 'paused')
    assert.equal(store.getState().error, null)
  })

  it('sets, mutes and restores the volume', () => {
    const { engine, store, actions } = setup()
    actions.setVolume(0.4)
    actions.toggleMute()
    assert.equal(store.getState().muted, true)
    actions.toggleMute()
    assert.equal(store.getState().volume, 0.4)
    actions.setVolume(7)
    assert.deepEqual(engine.volumes, [1, 0.4, 0, 0.4, 1])
  })

  it('plays a hand-picked song next, then carries on with the album', () => {
    const { engine, actions } = setup()
    actions.playCollection([track('a'), track('b')])
    actions.playNext([track('x')])
    engine.emit({ type: 'ended' })
    engine.emit({ type: 'ended' })
    assert.deepEqual(engine.loaded, ['/api/tracks/a/stream', '/api/tracks/x/stream', '/api/tracks/b/stream'])
  })

  it('queued songs wait until Play when nothing was playing', () => {
    const { engine, store, actions } = setup()
    actions.addToQueue([track('a'), track('b')])
    assert.equal(engine.loaded.length, 0)
    assert.equal(currentTrack(store.getState())?.id, 'a')
    actions.play()
    assert.deepEqual(engine.loaded, ['/api/tracks/a/stream'])
  })

  it('jumping to a queued song plays it', () => {
    const { engine, store, actions } = setup()
    actions.playCollection([track('a'), track('b'), track('c')])
    actions.jumpTo(store.getState().items[2].uid)
    assert.equal(engine.loaded.at(-1), '/api/tracks/c/stream')
  })

  it('toggling shuffle keeps the current song playing without reloading it', () => {
    const { engine, store, actions } = setup()
    actions.playCollection([track('a'), track('b'), track('c'), track('d')], { startIndex: 1 })
    actions.toggleShuffle()
    assert.equal(currentTrack(store.getState())?.id, 'b')
    assert.equal(store.getState().shuffle, true)
    actions.toggleShuffle()
    assert.deepEqual(store.getState().items.map((i) => i.track.id), ['a', 'b', 'c', 'd'])
    assert.equal(engine.loaded.length, 1)
  })

  it('repeat-one replays the song; repeat-all wraps to the start', () => {
    const { engine, actions } = setup()
    actions.playCollection([track('a'), track('b')], { startIndex: 1 })
    actions.cycleRepeat() // all
    engine.emit({ type: 'ended' })
    assert.equal(engine.loaded.at(-1), '/api/tracks/a/stream')
    actions.cycleRepeat() // one
    engine.emit({ type: 'ended' })
    assert.equal(engine.loaded.at(-1), '/api/tracks/a/stream')
    assert.deepEqual(engine.seeks.at(-1), 0)
  })
})
