import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideBack, handleBack, openBackLayers, pushBackLayer } from './back.ts'

/** A tiny router: a history stack like React Router's (idx = position). */
function app(start = '/') {
  const stack = [start]
  let idx = 0
  const log: string[] = []
  const env = {
    pathname: () => stack[idx],
    historyIndex: () => idx,
    goBack: () => { idx-- },
    goHome: () => { stack[idx] = '/' },
    hasMusic: () => music,
    minimize: () => log.push('minimize'),
    exit: () => log.push('exit'),
  }
  let music = false
  return {
    go(path: string) { stack.splice(idx + 1); stack.push(path); idx++ },
    back: () => handleBack(env),
    get path() { return stack[idx] },
    log,
    setMusic(v: boolean) { music = v },
  }
}

describe('Android Back', () => {
  it('goes back through PandaFM pages instead of closing the app', () => {
    const a = app()
    a.go('/albums/1')
    assert.equal(a.back(), 'history-back')
    assert.equal(a.path, '/')
    const b = app()
    b.go('/search?q=rock')
    b.go('/albums/2')
    b.back()
    assert.equal(b.path, '/search?q=rock')
    for (const page of ['/settings', '/now-playing', '/queue']) {
      const c = app()
      c.go('/artists/9')
      c.go(page)
      c.back()
      assert.equal(c.path, '/artists/9', page)
    }
  })

  it('closes an open dialog or menu first, newest first', () => {
    const a = app()
    a.go('/albums/1')
    const closed: string[] = []
    const offMenu = pushBackLayer(() => { closed.push('menu'); offMenu() })
    const offWhy = pushBackLayer(() => { closed.push('why'); offWhy() })
    assert.equal(openBackLayers(), 2)
    assert.equal(a.back(), 'close-layer')
    assert.equal(a.back(), 'close-layer')
    assert.deepEqual(closed, ['why', 'menu'])
    assert.equal(a.path, '/albums/1') // no navigation while layers were open
    assert.equal(a.back(), 'history-back')
  })

  it('at Home it leaves: the music keeps playing in the background, otherwise the app exits', () => {
    const quiet = app()
    assert.equal(quiet.back(), 'leave')
    assert.deepEqual(quiet.log, ['exit'])
    const playing = app()
    playing.setMusic(true)
    playing.back()
    assert.deepEqual(playing.log, ['minimize'])
  })

  it('an inner page opened directly goes Home first, and repeated presses end, without loops', () => {
    const a = app('/settings')
    const actions = [a.back(), a.back(), a.back()]
    assert.deepEqual(actions, ['go-home', 'leave', 'leave'])
    assert.equal(a.path, '/')
    const deep = app()
    for (const p of ['/library', '/albums/1', '/artists/2', '/settings']) deep.go(p)
    const seen: string[] = []
    for (let i = 0; i < 10 && deep.path !== '/'; i++) { deep.back(); seen.push(deep.path) }
    assert.deepEqual(seen, ['/artists/2', '/albums/1', '/library', '/'])
  })

  it('decides from layers first, then history, then where you are', () => {
    assert.equal(decideBack({ layers: 1, pathname: '/', historyIndex: 0 }), 'close-layer')
    assert.equal(decideBack({ layers: 0, pathname: '/albums/1', historyIndex: 3 }), 'history-back')
    assert.equal(decideBack({ layers: 0, pathname: '/albums/1', historyIndex: 0 }), 'go-home')
    assert.equal(decideBack({ layers: 0, pathname: '/', historyIndex: 0 }), 'leave')
  })
})
