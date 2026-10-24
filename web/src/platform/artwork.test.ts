import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createArtworkCache } from './artwork.ts'

function setup(max = 2) {
  const fetched: string[] = []
  const revoked: string[] = []
  let clock = 0
  let n = 0
  let fail = false
  const cache = createArtworkCache({
    fetcher: async (url) => {
      fetched.push(url)
      if (fail) throw new TypeError('offline')
      return new Response(new Blob(['jpg'], { type: url.includes('html') ? 'text/html' : 'image/jpeg' }), { status: url.includes('404') ? 404 : 200 })
    },
    createUrl: () => `blob:pandafm/${++n}`,
    revokeUrl: (u) => revoked.push(u),
    max,
    now: () => clock,
  })
  return { cache, fetched, revoked, tick: (ms: number) => { clock += ms }, failNext: (v: boolean) => { fail = v } }
}

describe('Android artwork cache', () => {
  it('fetches each cover once and shares it', async () => {
    const t = setup()
    const [a, b] = await Promise.all([t.cache.acquire('https://fm/api/covers/1'), t.cache.acquire('https://fm/api/covers/1')])
    assert.equal(a, 'blob:pandafm/1')
    assert.equal(a, b)
    assert.equal(t.fetched.length, 1)
    assert.equal(t.cache.peek('https://fm/api/covers/1'), a)
  })

  it('revokes the least recently used covers nobody shows any more', async () => {
    const t = setup(2)
    for (const id of [1, 2, 3]) {
      await t.cache.acquire(`https://fm/api/covers/${id}`)
      t.tick(10)
    }
    assert.deepEqual(t.revoked, []) // all three still shown
    t.cache.release('https://fm/api/covers/1')
    assert.deepEqual(t.revoked, ['blob:pandafm/1'])
    assert.equal(t.cache.size(), 2)
  })

  it('a failed cover is not hammered, and non-images are refused', async () => {
    const t = setup()
    t.failNext(true)
    assert.equal(await t.cache.acquire('https://fm/api/covers/x'), null)
    assert.equal(await t.cache.acquire('https://fm/api/covers/x'), null)
    assert.equal(t.fetched.length, 1) // waits a minute before trying again
    t.failNext(false)
    t.tick(61_000)
    assert.equal(await t.cache.acquire('https://fm/api/covers/x'), 'blob:pandafm/1')
    assert.equal(await t.cache.acquire('https://fm/api/covers/404'), null)
    assert.equal(await t.cache.acquire('https://fm/html'), null)
  })
})
