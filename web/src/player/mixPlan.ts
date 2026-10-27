// Panda Mix plans in the web app (5.2): the plan shape, the safe fallback, the
// transition timeline and gain/filter curves, and a small caching plan client.
// Pure (the client takes its fetch function), so it is unit-tested.

import type { Track } from '../api/library'

export type MixMode = 'auto' | 'gentle' | 'flow' | 'energetic'

export interface MixPlan {
  from: string
  to: string
  type: string
  label?: string
  summary: string
  explanation?: string
  outgoing_start_ms: number
  incoming_start_ms: number
  overlap_ms: number
  curve: 'equal_power' | 'linear'
  filter?: 'bass_swap' | 'highpass_out' | 'lowpass_in' | null
  bpm_out?: number | null
  bpm_in?: number | null
  key_out?: string | null
  key_in?: string | null
  confidence: number
  ready: boolean
  manual?: boolean
  /** smart | fallback | manual (5.3) */
  source?: 'smart' | 'fallback' | 'manual'
  /** a deliberately conservative choice (Clean Handoff, Quick Switch, Gapless): never a failure */
  intentional?: boolean
  index?: number
}

export const PRELOAD_S = 20
export const FALLBACK_TAIL_MS = 3000

/** The safe plan when Panda hasn't analysed the songs (the server's and Android's own): a recognisable blend that avoids A's tail. */
export function fallbackPlan(a: Pick<Track, 'id' | 'duration_seconds'>, b: Pick<Track, 'id'>, mode: MixMode): MixPlan {
  const duration = (a.duration_seconds ?? 0) * 1000
  const wanted = mode === 'gentle' ? 3500 : mode === 'energetic' ? 6000 : 5000
  const overlap = duration > wanted + FALLBACK_TAIL_MS ? wanted : 0
  return {
    from: a.id, to: b.id, type: 'smooth_blend', label: 'Smooth Blend', summary: `Smooth Blend · ${wanted / 1000} sec`,
    explanation: 'Panda hasn’t analysed these songs yet, so it uses a short, safe blend.',
    outgoing_start_ms: Math.max(0, duration - overlap - FALLBACK_TAIL_MS), incoming_start_ms: 0, overlap_ms: overlap,
    curve: 'equal_power', filter: null, confidence: 0.3, ready: false, source: 'fallback', intentional: false,
  }
}

/** When things happen, in seconds of the outgoing song. The handoff (logical current song) is the midpoint. */
export function timeline(plan: MixPlan) {
  const start = plan.outgoing_start_ms / 1000
  const overlap = Math.max(0, plan.overlap_ms) / 1000
  return { preloadAt: Math.max(0, start - PRELOAD_S), startAt: start, handoffAt: start + overlap / 2, endAt: start + overlap, overlap }
}

/** Gain curves for the outgoing and incoming decks: equal-power (no dip at the midpoint) or linear. */
export function gainCurves(curve: MixPlan['curve'], n = 64): { out: Float32Array; in: Float32Array } {
  const out = new Float32Array(n)
  const inn = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 1 : i / (n - 1)
    out[i] = curve === 'linear' ? 1 - p : Math.cos((p * Math.PI) / 2)
    inn[i] = curve === 'linear' ? p : Math.sin((p * Math.PI) / 2)
  }
  return { out, in: inn }
}

/** Bass Handoff: the outgoing lows leave in the first half, the incoming lows arrive in the second (low-shelf dB). */
export function bassCurves(n = 64): { out: Float32Array; in: Float32Array } {
  const out = new Float32Array(n)
  const inn = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const p = n === 1 ? 1 : i / (n - 1)
    out[i] = -24 * Math.min(1, p * 2) || 0 // 0 → -24 dB by the midpoint (never -0)
    inn[i] = -24 * Math.max(0, 1 - Math.max(0, p - 0.5) * 2) || 0 // -24 dB until the midpoint, then back to 0
  }
  return { out, in: inn }
}

type Fetcher = (body: unknown) => Promise<{ transitions: MixPlan[] }>
const facts = (t: Track) => ({ id: t.id, duration_seconds: t.duration_seconds, album_id: t.album_id, track_number: t.track_number, disc_number: t.disc_number, genres: t.genres ?? [] })

/** Plans by directional pair; never blocks (fallback first), re-fetches at most every 20 s while analysis runs. */
export class MixPlanner {
  private cache = new Map<string, MixPlan>()
  private fetched = new Map<string, number>()
  private readonly fetcher: Fetcher
  private readonly now: () => number

  constructor(fetcher: Fetcher, now: () => number = Date.now) {
    this.fetcher = fetcher
    this.now = now
  }

  static key(from: string, to: string, mode: MixMode, playlist: string | null) {
    return `${from}|${to}|${mode}|${playlist ?? ''}`
  }

  plan(a: Track, b: Track, mode: MixMode, playlist: string | null, window: Track[], onUpdate: () => void): MixPlan {
    const cached = this.cache.get(MixPlanner.key(a.id, b.id, mode, playlist))
    if (!cached?.ready) void this.fetch(window.length >= 2 ? window : [a, b], mode, playlist, false).then((any) => any && onUpdate())
    return cached ?? fallbackPlan(a, b, mode)
  }

  /** Every adjacent pair of an order, for the playlist/queue bridges (schedules analysis only for the lookahead). */
  async bridges(order: Track[], mode: MixMode, playlist: string | null): Promise<MixPlan[]> {
    await this.fetch(order, mode, playlist, true)
    return order.slice(0, -1).map((a, i) => this.cache.get(MixPlanner.key(a.id, order[i + 1].id, mode, playlist)) ?? fallbackPlan(a, order[i + 1], mode))
  }

  remember(plan: MixPlan, mode: MixMode, playlist: string | null) {
    this.cache.set(MixPlanner.key(plan.from, plan.to, mode, playlist), plan)
  }

  private async fetch(order: Track[], mode: MixMode, playlist: string | null, allPairs: boolean): Promise<boolean> {
    const key = `${order.map((t) => t.id).join(',')}|${mode}|${playlist ?? ''}|${allPairs}`
    const last = this.fetched.get(key)
    if (order.length < 2 || (last !== undefined && this.now() - last < 20_000)) return false
    this.fetched.set(key, this.now())
    try {
      const r = await this.fetcher({ tracks: order.slice(0, 500).map(facts), current_index: 0, playlist_id: playlist, mode, all_pairs: allPairs })
      for (const p of r.transitions) this.remember(p, mode, playlist)
      return r.transitions.length > 0
    } catch {
      return false // plans are a nicety: the fallback keeps the music going
    }
  }
}
