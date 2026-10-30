import { authFetch } from '../api/auth'
import { streamUrl } from '../api/library'
import { isNative } from '../platform/state'
import { scheduleTransition, type MixPlan } from './mixPlan'

/**
 * Preview a transition in isolation (5.2): ~10 s of A, the blend, ~8 s of B, in
 * its own Web Audio context. The main player is paused and restored afterwards;
 * the queue and its position are untouched. In the Android app the preview
 * fetches small AAC copies with the sign-in (the WebView has no session cookie).
 */
export async function previewTransition(plan: MixPlan, opts: { pauseMain: () => boolean; resumeMain: () => void; onEnd: () => void }): Promise<() => void> {
  const wasPlaying = opts.pauseMain()
  const ctx = new AudioContext()
  const lead = 10
  const tail = 8
  const src = async (id: string) => {
    if (!isNative()) return withQuality(streamUrl(id))
    const r = await authFetch(withQuality(streamUrl(id)))
    return URL.createObjectURL(await r.blob())
  }
  const [ua, ub] = await Promise.all([src(plan.from), src(plan.to)])
  const a = new Audio(ua)
  const b = new Audio(ub)
  // the same per-deck chain as the player (low shelf → high-pass → gain), so the preview is what plays
  const chain = (el: HTMLAudioElement) => {
    const shelf = ctx.createBiquadFilter()
    shelf.type = 'lowshelf'
    shelf.frequency.value = 200
    shelf.gain.value = 0
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 10
    const gain = ctx.createGain()
    ctx.createMediaElementSource(el).connect(shelf).connect(hp).connect(gain).connect(ctx.destination)
    return { shelf, hp, gain }
  }
  const da = chain(a)
  const db = chain(b)
  const gb = db.gain
  gb.gain.value = 0
  const start = plan.outgoing_start_ms / 1000
  const overlap = Math.max(0.01, plan.overlap_ms / 1000)
  a.currentTime = Math.max(0, start - lead)
  b.currentTime = plan.incoming_start_ms / 1000
  const timers: ReturnType<typeof setTimeout>[] = []
  let done = false
  const stop = () => {
    if (done) return
    done = true
    timers.forEach(clearTimeout)
    a.pause()
    b.pause()
    void ctx.close()
    if (ua.startsWith('blob:')) URL.revokeObjectURL(ua)
    if (ub.startsWith('blob:')) URL.revokeObjectURL(ub)
    if (wasPlaying) opts.resumeMain()
    opts.onEnd()
  }
  await a.play()
  const intoBlend = Math.max(0, start - a.currentTime) * 1000
  timers.push(setTimeout(() => {
    scheduleTransition(da, db, plan, ctx.currentTime, overlap)
    void b.play()
  }, intoBlend))
  timers.push(setTimeout(stop, intoBlend + (overlap + tail) * 1000))
  return stop
}

const withQuality = (url: string) => `${url}${url.includes('?') ? '&' : '?'}quality=low`
