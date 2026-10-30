import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiSend } from '../api/client'
import { noteConnectionEvent } from '../api/connection'
import { createLatest } from '../player/latest'
import type { Playlist, Track } from '../api/library'
import { openDialog } from '../dialogs/store'
import { toast } from '../library'
import { type MixMode, type MixPlan } from '../player/mixPlan'
import { mixPlanner, player, playerStore, usePlayer } from '../player'
import type { QueueSource } from '../player/queue'
import { isNative, platform } from '../platform/state'
import { Icon } from './Icon'
import { MenuButton, MenuItem } from './Menu'

const MODES: { id: MixMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Panda decides each transition' },
  { id: 'gentle', label: 'Gentle', hint: 'Short blends, clean handoffs' },
  { id: 'flow', label: 'Flow', hint: 'Smooth, beat-aware overlaps' },
  { id: 'energetic', label: 'Energetic', hint: 'Longer dance blends, bass handoffs' },
]

export interface MixPlaylistState {
  playlist_id: string
  enabled: boolean
  mode?: MixMode
  status?: 'preparing' | 'ready'
  analysed?: number
  total?: number
  order?: string[]
  /** 5.4: per song, only confident values (else null) and the analysis status. */
  facts?: Record<string, TrackFacts>
  /** 5.4: why each neighbour of the mixed order is there. */
  why?: { from: string; to: string; reasons: string[] }[]
}

export interface TrackFacts {
  status: 'ready' | 'failed' | 'pending' | 'queued' | 'analysing'
  bpm?: number | null
  key?: string | null
  camelot?: string | null
}

/** "88 BPM · A minor · 8A", or an honest state: never a value Panda isn't sure about. */
export function FactsLine({ facts }: { facts?: TrackFacts }) {
  if (!facts) return null
  if (facts.status === 'analysing') return <>Analyzing…</>
  if (facts.status === 'pending' || facts.status === 'queued') return <>Analysis pending</>
  if (facts.status === 'failed') return <>Couldn’t analyse this song</>
  const tempo = facts.bpm ? `${facts.bpm} BPM` : 'Tempo uncertain'
  if (!facts.camelot) return <>{tempo} · Key uncertain</>
  return <>{tempo} · {facts.key && <span className="fact-key-name">{facts.key} · </span>}{facts.camelot}</>
}

/** A playlist's Panda Mix (5.3): on or off, its personality, and its stable mixed order (re-read while preparing). */
export function useMixPlaylist(playlistId: string) {
  const [state, setState] = useState<MixPlaylistState | null>(null)
  const load = useCallback(() => apiGet<MixPlaylistState>(`/mix/playlists/${encodeURIComponent(playlistId)}`).then(setState, () => setState(null)), [playlistId])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (state?.status !== 'preparing') return
    const timer = setTimeout(() => void load(), 15_000)
    return () => clearTimeout(timer)
  }, [state, load])
  return { state, setState, reload: load }
}

/** The playlist's tracks in Panda Mix order (songs the order doesn't know yet keep their place at the end). */
import { inMixOrder } from '../library/mixOrder'
export { inMixOrder, mixEntries } from '../library/mixOrder'

/**
 * 5.5.2: apply a mode change or Remix to the playing queue if it is this playlist's Panda Mix:
 * 'live' (the future follows now; the current song is untouched), 'next-time' (playing, but not applied
 * now, e.g. shuffled: it applies next time) or 'not-playing'.
 */
export async function liveEdit(playlistId: string, change: { mode?: MixMode; order?: string[] }): Promise<'live' | 'next-time' | 'not-playing'> {
  const q = playerStore.getState()
  const mix = (q.source as (QueueSource & { mix?: { playlistId?: string } }) | null)?.mix
  if (mix?.playlistId !== playlistId || q.items.length === 0) return 'not-playing'
  noteConnectionEvent(`Panda Mix edit while playing: ${change.mode ? `mode ${change.mode}` : 'remix'}`)
  return (await player.updateMix(playlistId, change)) ? 'live' : 'next-time'
}

/**
 * Playlist pages: Panda Mix as a lasting setting (5.3). Turning it on analyses the whole playlist once
 * and gives it a stable mixed order. While enabled, the primary Play action uses that mix until the
 * user turns Panda Mix off; the original Navidrome order is still available explicitly.
 */
export function PandaMixControls({ playlist, source, mix, view, onView }: {
  playlist: Playlist
  source: QueueSource
  mix: ReturnType<typeof useMixPlaylist>
  view: 'mixed' | 'original'
  onView: (v: 'mixed' | 'original') => void
}) {
  const state = mix.state
  const play = (s: MixPlaylistState) =>
    player.playCollection(inMixOrder(playlist.tracks, s.order), { source: { ...source, mix: { mode: s.mode ?? 'auto', playlistId: playlist.id } }, shuffle: false })
  // 5.5.2: the latest choice wins (rapid Auto → Flow → Energetic → Gentle, or Remix again): a slower,
  // older response is ignored when it arrives.
  const latest = useRef(createLatest()).current
  const enabledBefore = !!state?.enabled
  const turnOn = async (mode: MixMode, andPlay: boolean) => {
    const ticket = latest.begin()
    try {
      const s = await apiSend<MixPlaylistState>('PUT', `/mix/playlists/${encodeURIComponent(playlist.id)}`, { mode })
      if (!latest.isLatest(ticket)) return
      mix.setState(s)
      onView('mixed')
      if (andPlay) play(s)
      else if (enabledBefore) {
        const label = MODES.find((m) => m.id === mode)?.label ?? mode
        const r = await liveEdit(playlist.id, { mode })
        if (!latest.isLatest(ticket)) return
        if (r === 'live') toast(`Upcoming transitions use ${label}`)
        else if (r === 'next-time') toast(`${label} applies the next time this mix plays`)
      }
      if (s.status === 'preparing') toast('Panda is preparing this playlist’s mix. It plays right away and gets smarter as songs are analysed.')
    } catch (err) {
      if (latest.isLatest(ticket)) toast(err instanceof Error ? err.message : 'Couldn’t turn on Panda Mix', 'error')
    }
  }
  const remix = async () => {
    const ticket = latest.begin()
    const s = await apiSend<MixPlaylistState>('POST', `/mix/playlists/${encodeURIComponent(playlist.id)}/remix`).catch(() => null)
    if (!s || !latest.isLatest(ticket)) return
    mix.setState(s)
    onView('mixed')
    const r = await liveEdit(playlist.id, { order: s.order })
    if (!latest.isLatest(ticket)) return
    toast(r === 'live' ? 'Remixed: the upcoming songs follow the new order' : r === 'next-time' ? 'Remixed: the new order plays the next time this mix starts' : 'Remixed: a new Panda Mix order')
  }
  const turnOff = async () => {
    await apiSend('DELETE', `/mix/playlists/${encodeURIComponent(playlist.id)}`).catch(() => undefined)
    mix.setState({ playlist_id: playlist.id, enabled: false })
    onView('original')
    toast('Panda Mix is off for this playlist')
  }
  const prepare = () => {
    void platform.player?.prepareMixOffline({ tracks: JSON.stringify(inMixOrder(playlist.tracks, state?.order)), playlistId: playlist.id, mode: state?.mode ?? 'auto' })
    toast('Panda is preparing this playlist’s transitions for offline listening.')
  }
  if (!state?.enabled) {
    return (
      <>
        <button type="button" className="button button--quiet panda-mix-button" disabled={playlist.tracks.length < 2} onClick={() => void turnOn('auto', true)}>
          <Icon name="radio" /> Panda Mix
        </button>
        <MenuButton label="Panda Mix style">
          {(close) => MODES.map((m) => <MenuItem key={m.id} icon="radio" label={`Panda Mix · ${m.label}`} onSelect={() => { close(); void turnOn(m.id, true) }} />)}
        </MenuButton>
      </>
    )
  }
  return (
    <>
      <button type="button" className="button panda-mix-button" onClick={() => play(state)}>
        <Icon name="radio" /> Play Panda Mix
      </button>
      <MenuButton label="Panda Mix options">
        {(close) => (
          <>
            {MODES.map((m) => (
              <MenuItem key={m.id} icon={state.mode === m.id ? 'check' : 'radio'} label={`${m.label} · ${m.hint}`} onSelect={() => { close(); void turnOn(m.id, false) }} />
            ))}
            <MenuItem icon="queue" label={view === 'mixed' ? 'Show original order' : 'Show mixed order'} onSelect={() => { close(); onView(view === 'mixed' ? 'original' : 'mixed') }} />
            <MenuItem icon="play" label="Play original order" onSelect={() => { close(); player.playCollection(playlist.tracks, { source, shuffle: false }) }} />
            <MenuItem icon="shuffle" label="Remix" onSelect={() => { close(); void remix() }} />
            {isNative() && <MenuItem icon="download" label="Prepare Panda Mix (offline)" onSelect={() => { close(); prepare() }} />}
            <MenuItem icon="close" label="Turn off Panda Mix" onSelect={() => { close(); void turnOff() }} />
          </>
        )}
      </MenuButton>
    </>
  )
}

/** One line under the playlist title: is Panda Mix still preparing, or is the final order active? */
export function PandaMixStatus({ mix, view }: { mix: ReturnType<typeof useMixPlaylist>; view: 'mixed' | 'original' }) {
  const s = mix.state
  if (!s?.enabled) return null
  const label = MODES.find((m) => m.id === s.mode)?.label ?? 'Auto'
  const total = s.total ?? 0
  const state = s.status === 'preparing' ? `Panda Mix analyzing · ${s.analysed ?? 0} / ${total} tracks` : `Panda Mix ready · ${total} tracks analyzed`
  const shown = view === 'mixed' ? (s.status === 'preparing' ? 'playlist order until analysis finishes' : 'mixed order') : 'original order'
  return <p className="panda-mix-status" role="status"><Icon name="radio" /> {state} · {label} · {shown}</p>
}

/** 5.4: plans for every neighbour of the playlist's mixed order (the same records the queue uses). */
export function usePlaylistBridges(order: Track[], mode: MixMode | undefined, playlistId: string, enabled: boolean, analysed: number) {
  const [plans, setPlans] = useState(new Map<string, MixPlan>())
  const key = order.map((t) => t.id).join(',')
  useEffect(() => {
    if (!enabled || order.length < 2 || !mode) return
    let live = true
    void mixPlanner.bridges(order, mode, playlistId).then((list) => {
      if (live) setPlans(new Map(list.map((p) => [`${p.from}|${p.to}`, p])))
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, mode, playlistId, enabled, analysed])
  return plans
}

/** The transition between two songs of the playlist's mixed order: tap for its details and Adjust Mix. */
export function PlaylistBridge({ from, to, plan, why, mode, playlistId }: {
  from: Track
  to: Track
  plan: MixPlan | undefined
  why: string[] | undefined
  mode: MixMode
  playlistId: string
}) {
  const [open, setOpen] = useState(false)
  const facts = plan && [
    plan.bpm_out && plan.bpm_in ? `${Math.round(plan.bpm_out)} → ${Math.round(plan.bpm_in)} BPM` : null,
    plan.key_out && plan.key_in ? `${plan.key_out} → ${plan.key_in}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <li className="mix-bridge mix-bridge--playlist">
      <button type="button" className="mix-bridge-button" disabled={!plan}
        onClick={() => plan && openDialog({ type: 'mix-transition', plan, from, to, mode, playlistId })}
        aria-label={plan ? `Transition from ${from.title} to ${to.title}: ${plan.summary}. Adjust Mix` : 'Preparing the transition'}>
        <Icon name="radio" />
        <span className="mix-bridge-text">
          <span>{plan ? (plan.ready ? plan.summary : `${plan.summary} · Preparing…`) : 'Preparing…'}{plan?.manual ? ' · yours' : ''}</span>
          {facts && <span className="mix-bridge-facts">{facts}</span>}
        </span>
        <span className="mix-bridge-adjust">Adjust Mix</span>
      </button>
      {why && why.length > 0 && (
        <button type="button" className="mix-why-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>Why here?</button>
      )}
      {open && why && <ul className="mix-why">{why.map((r) => <li key={r}>{r}</li>)}</ul>}
    </li>
  )
}

/** The plans for the queue's next few transitions (shared by the bridges). */
export function useMixBridges(): Map<string, MixPlan> {
  const items = usePlayer((s) => s.items)
  const index = usePlayer((s) => s.index)
  const mix = usePlayer((s) => s.source?.mix)
  const [plans, setPlans] = useState(new Map<string, MixPlan>())
  useEffect(() => {
    if (!mix || index < 0) return
    let live = true
    const order = items.slice(index, index + 12).map((i) => i.track)
    const load = () => mixPlanner.bridges(order, mix.mode, mix.playlistId ?? null).then((list) => {
      if (live) setPlans(new Map(list.map((p) => [`${p.from}|${p.to}`, p])))
      return list
    })
    void load().then((list) => {
      if (list.some((p) => !p.ready)) setTimeout(() => live && void load(), 20_000) // "Preparing…" settles as analysis finishes
    })
    return () => { live = false }
  }, [items, index, mix])
  return plans
}

/** A compact bridge between two songs of a Panda Mix; tap for the summary and Adjust Mix. */
export function MixBridge({ from, to, plans }: { from: Track; to: Track; plans: Map<string, MixPlan> }) {
  const mix = usePlayer((s) => s.source?.mix)
  if (!mix) return null
  const plan = plans.get(`${from.id}|${to.id}`)
  return (
    <li className="mix-bridge">
      <button type="button" className="mix-bridge-button" disabled={!plan}
        onClick={() => plan && openDialog({ type: 'mix-transition', plan, from, to, mode: mix.mode, playlistId: mix.playlistId ?? null })}>
        <Icon name="radio" />
        <span>Panda Mix · {plan ? (plan.ready ? plan.summary : `${plan.summary} · Preparing…`) : 'Preparing…'}{plan?.manual ? ' · yours' : ''}</span>
      </button>
    </li>
  )
}
