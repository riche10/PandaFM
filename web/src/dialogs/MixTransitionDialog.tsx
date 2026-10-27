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
type Analysis = { duration_ms: number; waveform: number[]; bpm: number | null; bpm_confidence: number; key_camelot: string | null; key_confidence: number }

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`

function Wave({ data, from, to, total, side }: { data: number[]; from: number; to: number; total: number; side: 'out' | 'in' }) {
  const w = 600
  const h = 64
  const path = data.map((v, i) => `${((i / Math.max(1, data.length - 1)) * w).toFixed(1)},${(h / 2 - (v * h) / 2).toFixed(1)}`).join(' ')
  const x0 = (from / Math.max(1, total)) * w
  const x1 = (to / Math.max(1, total)) * w
  const curve = gainCurves('equal_power', 24)
  const g = side === 'out' ? curve.out : curve.in
  const gain = Array.from(g).map((v, i) => `${(x0 + ((x1 - x0) * i) / (g.length - 1)).toFixed(1)},${(h - v * h).toFixed(1)}`).join(' ')
  return (
    <svg className="mix-wave" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={side === 'out' ? 'Outgoing song waveform' : 'Incoming song waveform'}>
      <rect x={x0} y={0} width={Math.max(1, x1 - x0)} height={h} className="mix-wave-region" />
      <polyline points={path} className="mix-wave-line" />
      <polyline points={data.map((v, i) => `${((i / Math.max(1, data.length - 1)) * w).toFixed(1)},${(h / 2 + (v * h) / 2).toFixed(1)}`).join(' ')} className="mix-wave-line" />
      <polyline points={gain} className="mix-wave-gain" />
      <line x1={(x0 + x1) / 2} x2={(x0 + x1) / 2} y1={0} y2={h} className="mix-wave-mid" />
    </svg>
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
    if (!editing) return
    apiGet<{ analysis: Analysis | null }>(`/mix/analysis/${encodeURIComponent(from.id)}`).then((r) => setA(r.analysis), () => undefined)
    apiGet<{ analysis: Analysis | null }>(`/mix/analysis/${encodeURIComponent(to.id)}`).then((r) => setB(r.analysis), () => undefined)
  }, [editing, from.id, to.id])
  useEffect(() => () => previewing?.(), [previewing])
  const aDur = a?.duration_ms ?? (from.duration_seconds ?? 0) * 1000
  const bDur = b?.duration_ms ?? (to.duration_seconds ?? 0) * 1000
  const facts = useMemo(() => [
    ['Type', plan.label ?? plan.type],
    ['Duration', plan.type === 'gapless' ? 'Gapless' : sec(plan.overlap_ms)],
    ['Tempo', plan.bpm_out && plan.bpm_in ? `${Math.round(plan.bpm_out)} → ${Math.round(plan.bpm_in)} BPM` : 'Not sure'],
    ['Key', plan.key_out && plan.key_in ? `${plan.key_out} → ${plan.key_in}` : 'Not sure'],
    ['Confidence', plan.confidence >= 0.7 ? 'High' : plan.confidence >= 0.45 ? 'Medium' : 'Low'],
    ['Chosen by', plan.manual ? 'You' : 'Panda (Auto)'],
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

  if (!editing) {
    return (
      <>
        <h2 className="modal-title">{plan.summary}</h2>
        <p className="hint">{from.title} → {to.title}</p>
        {plan.explanation && <p>{plan.explanation}</p>}
        <dl className="info-list">{facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        <div className="modal-actions">
          <button type="button" className="button button--quiet" onClick={closeDialog}>Done</button>
          <button type="button" className="button" onClick={() => setEditing(true)}>Adjust Mix</button>
        </div>
      </>
    )
  }
  const set = (patch: Partial<MixPlan>) => setPlan({ ...plan, ...patch, manual: true })
  const outMin = Math.max(0, aDur - 60000)
  return (
    <div className="mix-editor">
      <h2 className="modal-title">Adjust Mix</h2>
      <p className="hint">{from.title} → {to.title}. Saved for this pair in this playlist only.</p>
      <p className="mix-editor-label">Outgoing: {from.title}{a?.bpm ? ` · ${Math.round(a.bpm)} BPM` : ''}</p>
      {a ? <Wave data={a.waveform} from={plan.outgoing_start_ms} to={plan.outgoing_start_ms + plan.overlap_ms} total={aDur} side="out" /> : <p className="hint">Panda is preparing this song…</p>}
      <p className="mix-editor-label">Incoming: {to.title}{b?.bpm ? ` · ${Math.round(b.bpm)} BPM` : ''}</p>
      {b ? <Wave data={b.waveform} from={plan.incoming_start_ms} to={plan.incoming_start_ms + plan.overlap_ms} total={bDur} side="in" /> : <p className="hint">Panda is preparing this song…</p>}
      <label className="field">
        <span className="field-label">Transition</span>
        <select className="field-input" value={plan.type} onChange={(e) => set({ type: e.target.value, label: TYPES.find(([id]) => id === e.target.value)?.[1], overlap_ms: e.target.value === 'gapless' ? 0 : plan.overlap_ms || 6000, filter: e.target.value === 'bass_handoff' ? 'bass_swap' : e.target.value === 'filter_glide' ? 'highpass_out' : null })}>
          {TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <label className="control-slider">
        <span className="control-slider-head"><span>Transition starts</span><span>{sec(plan.outgoing_start_ms)}</span></span>
        <input type="range" min={outMin} max={Math.max(outMin, aDur - plan.overlap_ms)} step={250} value={plan.outgoing_start_ms} onChange={(e) => set({ outgoing_start_ms: Number(e.target.value) })} />
      </label>
      <label className="control-slider">
        <span className="control-slider-head"><span>Incoming starts at</span><span>{sec(plan.incoming_start_ms)}</span></span>
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
      <div className="modal-actions mix-editor-actions">
        <button type="button" className="button button--quiet" onClick={() => void reset()}>Reset Auto</button>
        <button type="button" className="button button--quiet" onClick={() => void preview()}>{previewing ? 'Stop preview' : 'Preview'}</button>
        <button type="button" className="button" onClick={() => void save()}>Save</button>
      </div>
    </div>
  )
}
