import { useEffect, useMemo, useState } from 'react'
import { apiGet, apiSend } from '../api/client'
import type { Track } from '../api/library'
import { toast } from '../library'
import { mixPlanner, player, usePlayer } from '../player'
import { gainCurves, type MixMode, type MixPlan } from '../player/mixPlan'
import { previewTransition } from '../player/mixPreview'
import { closeDialog } from './store'

const TYPES: [string, string][] = [
  ['smooth_blend', 'Smooth Blend'], ['deep_blend', 'Deep Blend'], ['bass_handoff', 'Bass Handoff'], ['filter_glide', 'Filter Glide'],
  ['quick_switch', 'Quick Switch'], ['clean_handoff', 'Clean Handoff'], ['gapless', 'Gapless'],
]

interface Analysis {
  duration_ms: number
  waveform: number[]
  bpm: number | null
  bpm_confidence: number
  key: string | null
  key_camelot: string | null
  key_confidence: number
  mix_in_ms?: number
  mix_out_ms?: number
  audible_end_ms?: number
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
const confidence = (c: number) => (c >= 0.7 ? 'High' : c >= 0.45 ? 'Medium' : 'Low')

/** "88 BPM · A minor · 8A", only what the analysis is sure of. */
function musicalFacts(a: Analysis | null): string {
  if (!a) return 'Panda is preparing this song…'
  const tempo = a.bpm && a.bpm_confidence >= 0.4 ? `${Math.round(a.bpm)} BPM` : 'Tempo uncertain'
  const key = a.key_camelot && a.key_confidence >= 0.3 ? `${a.key ? `${a.key} · ` : ''}${a.key_camelot}` : 'Key uncertain'
  return `${tempo} · ${key}`
}

/**
 * One track's waveform with the transition drawn on it (5.4: large and labelled): the region, the
 * gain (fade) curve, its midpoint, the song's musical mix-in/mix-out point and time labels.
 */
function Wave({ a, from, to, side, curve }: { a: Analysis; from: number; to: number; side: 'out' | 'in'; curve: MixPlan['curve'] }) {
  const w = 1000
  const h = 140
  const total = Math.max(1, a.duration_ms)
  const x = (ms: number) => Math.max(0, Math.min(w, (ms / total) * w))
  const n = a.waveform.length
  const top = a.waveform.map((v, i) => `${((i / Math.max(1, n - 1)) * w).toFixed(1)},${(h / 2 - (v * (h - 24)) / 2).toFixed(1)}`).join(' ')
  const bottom = a.waveform.map((v, i) => `${((i / Math.max(1, n - 1)) * w).toFixed(1)},${(h / 2 + (v * (h - 24)) / 2).toFixed(1)}`).join(' ')
  const x0 = x(from)
  const x1 = x(to)
  const g = side === 'out' ? gainCurves(curve, 32).out : gainCurves(curve, 32).in
  const gain = Array.from(g).map((v, i) => `${(x0 + ((x1 - x0) * i) / (g.length - 1)).toFixed(1)},${(h - 12 - v * (h - 24)).toFixed(1)}`).join(' ')
  const marker = side === 'out' ? a.mix_out_ms : a.mix_in_ms
  return (
    <svg className="mix-wave" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img"
      aria-label={`${side === 'out' ? 'Outgoing' : 'Incoming'} waveform; transition ${clock(from)} to ${clock(to)}`}>
      <rect x={x0} y={0} width={Math.max(2, x1 - x0)} height={h} className="mix-wave-region" />
      <polyline points={top} className="mix-wave-line" />
      <polyline points={bottom} className="mix-wave-line" />
      <polyline points={gain} className="mix-wave-gain" />
      <line x1={(x0 + x1) / 2} x2={(x0 + x1) / 2} y1={0} y2={h} className="mix-wave-mid" />
      {marker !== undefined && (
        <line x1={x(marker)} x2={x(marker)} y1={0} y2={h} className="mix-wave-marker">
          <title>{side === 'out' ? `Musical end ${clock(marker)}` : `Gets going ${clock(marker)}`}</title>
        </line>
      )}
    </svg>
  )
}

function WaveLabels({ from, to, total, side, marker }: { from: number; to: number; total: number; side: 'out' | 'in'; marker?: number }) {
  return (
    <div className="mix-wave-labels">
      <span>{clock(from)}</span>
      <span className="mix-wave-labels-mid">{side === 'out' ? 'transition starts → midpoint ↑' : 'comes in → midpoint ↑'}{marker !== undefined ? ` · ${side === 'out' ? 'musical end' : 'gets going'} ${clock(marker)}` : ''}</span>
      <span>{clock(to)} / {clock(total)}</span>
    </div>
  )
}

/** A transition's summary, and the Adjust Mix editor (saved for exactly this pair in this playlist). */
export function MixTransitionDialog({ plan: initial, from, to, mode, playlistId }: { plan: MixPlan; from: Track; to: Track; mode: MixMode; playlistId: string | null }) {
  const [editing, setEditing] = useState(false)
  const [plan, setPlan] = useState(initial)
  const [a, setA] = useState<Analysis | null>(null)
  const [b, setB] = useState<Analysis | null>(null)
  const [previewing, setPreviewing] = useState<(() => void) | null>(null)
  const status = usePlayer((s) => s.status)
  useEffect(() => {
    apiGet<{ analysis: Analysis | null }>(`/mix/analysis/${encodeURIComponent(from.id)}`).then((r) => setA(r.analysis), () => undefined)
    apiGet<{ analysis: Analysis | null }>(`/mix/analysis/${encodeURIComponent(to.id)}`).then((r) => setB(r.analysis), () => undefined)
  }, [from.id, to.id])
  useEffect(() => () => previewing?.(), [previewing])
  const aDur = a?.duration_ms ?? (from.duration_seconds ?? 0) * 1000
  const bDur = b?.duration_ms ?? (to.duration_seconds ?? 0) * 1000
  const reasons = (plan as MixPlan & { reasons?: string[] }).reasons ?? []
  const facts = useMemo(() => [
    ['Transition', plan.type === 'gapless' ? 'Gapless' : `${plan.label ?? plan.type} · ${sec(plan.overlap_ms)}`],
    ['Tempo', plan.bpm_out && plan.bpm_in ? `${Math.round(plan.bpm_out)} → ${Math.round(plan.bpm_in)} BPM` : 'Uncertain'],
    ['Key', plan.key_out && plan.key_in ? `${plan.key_out} → ${plan.key_in}` : 'Uncertain'],
    ['Confidence', confidence(plan.confidence)],
    ['Chosen by', plan.manual ? 'You (this playlist)' : plan.source === 'fallback' ? 'Panda (safe fallback: not analysed yet)' : 'Panda (Auto)'],
  ], [plan])

  const save = async () => {
    try {
      const saved = await apiSend<MixPlan>('PUT', '/mix/transition', {
        from_track: from.id, to_track: to.id, playlist_id: playlistId, type: plan.type, outgoing_start_ms: Math.round(plan.outgoing_start_ms),
        incoming_start_ms: Math.round(plan.incoming_start_ms), overlap_ms: Math.round(plan.overlap_ms), curve: plan.curve, filter: plan.filter ?? null,
        a_duration_ms: Math.max(1, Math.round(aDur)), b_duration_ms: Math.max(1, Math.round(bDur)),
      })
      mixPlanner.remember({ ...plan, ...saved, ready: true, manual: true }, mode, playlistId)
      toast('Saved this transition for this playlist')
      closeDialog()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Couldn’t save the transition', 'error')
    }
  }
  const reset = async () => {
    await apiSend('DELETE', `/mix/transition?from_track=${encodeURIComponent(from.id)}&to_track=${encodeURIComponent(to.id)}${playlistId ? `&playlist_id=${encodeURIComponent(playlistId)}` : ''}`).catch(() => undefined)
    mixPlanner.remember({ ...initial, manual: false, ready: false }, mode, playlistId) // Auto again on the next fetch
    toast('Back to Panda’s choice')
    closeDialog()
  }
  const preview = async () => {
    if (previewing) return previewing()
    try {
      const stop = await previewTransition(plan, {
        pauseMain: () => { const playing = status === 'playing'; if (playing) player.pause(); return playing },
        resumeMain: () => player.play(),
        onEnd: () => setPreviewing(null),
      })
      setPreviewing(() => stop)
    } catch {
      toast('Couldn’t preview this transition', 'error')
    }
  }

  const why = (
    <div className="mix-why-panel">
      <p className="mix-why-title">{plan.label ?? plan.type}</p>
      <ul className="mix-why">{reasons.map((r) => <li key={r}>{r}</li>)}<li>Confidence: {confidence(plan.confidence)}</li></ul>
      {plan.explanation && <p className="hint">{plan.explanation}</p>}
    </div>
  )
  const tracks = (
    <div className="mix-editor-tracks">
      <div><p className="mix-editor-role">Outgoing</p><p className="mix-editor-title">{from.title}</p><p className="mix-editor-facts">{musicalFacts(a)}</p></div>
      <div><p className="mix-editor-role">Incoming</p><p className="mix-editor-title">{to.title}</p><p className="mix-editor-facts">{musicalFacts(b)}</p></div>
    </div>
  )

  if (!editing) {
    return (
      <div className="mix-summary">
        <h2 className="modal-title">{plan.summary}</h2>
        {tracks}
        {why}
        <dl className="info-list">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        <div className="modal-actions">
          <button type="button" className="button button--quiet" onClick={closeDialog}>Done</button>
          <button type="button" className="button" onClick={() => setEditing(true)}>Adjust Mix</button>
        </div>
      </div>
    )
  }
  const set = (patch: Partial<MixPlan>) => setPlan({ ...plan, ...patch, manual: true })
  const outMin = Math.max(0, aDur - 60000)
  return (
    <div className="mix-editor">
      <h2 className="modal-title">Adjust Mix</h2>
      <p className="hint">Saved for this pair in this playlist only. Panda keeps its own choice everywhere else.</p>
      {tracks}
      <p className="mix-editor-label">Outgoing · {from.title}</p>
      {a ? (
        <>
          <Wave a={a} from={plan.outgoing_start_ms} to={plan.outgoing_start_ms + plan.overlap_ms} side="out" curve={plan.curve} />
          <WaveLabels from={plan.outgoing_start_ms} to={plan.outgoing_start_ms + plan.overlap_ms} total={aDur} side="out" marker={a.mix_out_ms} />
        </>
      ) : <p className="hint">Panda is preparing this song…</p>}
      <p className="mix-editor-label">Incoming · {to.title}</p>
      {b ? (
        <>
          <Wave a={b} from={plan.incoming_start_ms} to={plan.incoming_start_ms + plan.overlap_ms} side="in" curve={plan.curve} />
          <WaveLabels from={plan.incoming_start_ms} to={plan.incoming_start_ms + plan.overlap_ms} total={bDur} side="in" marker={b.mix_in_ms} />
        </>
      ) : <p className="hint">Panda is preparing this song…</p>}
      {why}
      <div className="mix-editor-controls">
        <label className="field">
          <span className="field-label">Transition</span>
          <select className="field-input" value={plan.type} onChange={(e) => set({ type: e.target.value, label: TYPES.find(([id]) => id === e.target.value)?.[1], overlap_ms: e.target.value === 'gapless' ? 0 : plan.overlap_ms || 6000, filter: e.target.value === 'bass_handoff' ? 'bass_swap' : e.target.value === 'filter_glide' ? 'highpass_out' : null })}>
            {TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <label className="control-slider">
          <span className="control-slider-head"><span>Transition starts</span><span>{clock(plan.outgoing_start_ms)}</span></span>
          <input type="range" min={outMin} max={Math.max(outMin, aDur - plan.overlap_ms)} step={250} value={plan.outgoing_start_ms} onChange={(e) => set({ outgoing_start_ms: Number(e.target.value) })} />
        </label>
        <label className="control-slider">
          <span className="control-slider-head"><span>Incoming starts at</span><span>{clock(plan.incoming_start_ms)}</span></span>
          <input type="range" min={0} max={Math.min(30000, Math.max(0, bDur - plan.overlap_ms))} step={250} value={plan.incoming_start_ms} onChange={(e) => set({ incoming_start_ms: Number(e.target.value) })} />
        </label>
        <label className="control-slider">
          <span className="control-slider-head"><span>Overlap</span><span>{sec(plan.overlap_ms)}</span></span>
          <input type="range" min={0} max={30000} step={250} value={plan.overlap_ms} disabled={plan.type === 'gapless'} onChange={(e) => set({ overlap_ms: Number(e.target.value), outgoing_start_ms: Math.min(plan.outgoing_start_ms, Math.max(0, aDur - Number(e.target.value))) })} />
        </label>
        <label className="check-option">
          <input type="checkbox" checked={plan.curve === 'linear'} onChange={(e) => set({ curve: e.target.checked ? 'linear' : 'equal_power' })} />
          Linear fade (instead of equal-power)
        </label>
      </div>
      <div className="modal-actions mix-editor-actions">
        <button type="button" className="button button--quiet" onClick={() => void reset()}>Reset Auto</button>
        <button type="button" className="button button--quiet" onClick={() => void preview()}>{previewing ? 'Stop preview' : 'Preview'}</button>
        <button type="button" className="button" onClick={() => void save()}>Save</button>
      </div>
    </div>
  )
}
