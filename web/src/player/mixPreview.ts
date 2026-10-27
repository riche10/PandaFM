import { authFetch } from '../api/auth'
import { streamUrl } from '../api/library'
import { isNative } from '../platform/state'
import { gainCurves, type MixPlan } from './mixPlan'

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
  const ga = ctx.createGain()
  const gb = ctx.createGain()
  ctx.createMediaElementSource(a).connect(ga).connect(ctx.destination)
  ctx.createMediaElementSource(b).connect(gb).connect(ctx.destination)
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
    const c = gainCurves(plan.curve)
    ga.gain.setValueCurveAtTime(c.out, ctx.currentTime, overlap)
    gb.gain.setValueCurveAtTime(c.in, ctx.currentTime, overlap)
    void b.play()
  }, intoBlend))
  timers.push(setTimeout(stop, intoBlend + (overlap + tail) * 1000))
  return stop
}

const withQuality = (url: string) => `${url}${url.includes('?') ? '&' : '?'}quality=low`
