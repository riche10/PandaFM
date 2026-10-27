import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiSend } from '../api/client'
import type { Playlist, Track } from '../api/library'
import { openDialog } from '../dialogs/store'
import { toast } from '../library'
import { type MixMode, type MixPlan } from '../player/mixPlan'
import { mixPlanner, player, usePlayer } from '../player'
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
export function inMixOrder(tracks: Track[], order: string[] | undefined): Track[] {
  if (!order?.length) return tracks
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const seen = new Set<string>()
  const out: Track[] = []
  for (const id of order) {
    const t = byId.get(id)
    if (t && !seen.has(id)) { out.push(t); seen.add(id) }
  }
  return [...out, ...tracks.filter((t) => !seen.has(t.id))]
}

/**
 * Playlist pages: Panda Mix as a lasting setting (5.3). Turning it on analyses the whole playlist once
 * and gives it a stable mixed order; the playlist itself (and normal Play) stays exactly as it is.
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
  const turnOn = async (mode: MixMode, andPlay: boolean) => {
    try {
      const s = await apiSend<MixPlaylistState>('PUT', `/mix/playlists/${encodeURIComponent(playlist.id)}`, { mode })
      mix.setState(s)
      onView('mixed')
      if (andPlay) play(s)
      if (s.status === 'preparing') toast('Panda is preparing this playlist’s mix. It plays right away and gets smarter as songs are analysed.')
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Couldn’t turn on Panda Mix', 'error')
    }
  }
  const remix = async () => {
    const s = await apiSend<MixPlaylistState>('POST', `/mix/playlists/${encodeURIComponent(playlist.id)}/remix`).catch(() => null)
    if (s) { mix.setState(s); onView('mixed'); toast('Remixed: a new Panda Mix order') }
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
            <MenuItem icon="shuffle" label="Remix" onSelect={() => { close(); void remix() }} />
            {isNative() && <MenuItem icon="download" label="Prepare Panda Mix (offline)" onSelect={() => { close(); prepare() }} />}
            <MenuItem icon="close" label="Turn off Panda Mix" onSelect={() => { close(); void turnOff() }} />
          </>
        )}
      </MenuButton>
    </>
  )
}

/** One line under the playlist title: what Panda Mix is doing for this playlist. */
export function PandaMixStatus({ mix, view }: { mix: ReturnType<typeof useMixPlaylist>; view: 'mixed' | 'original' }) {
  const s = mix.state
  if (!s?.enabled) return null
  const label = MODES.find((m) => m.id === s.mode)?.label ?? 'Auto'
  const progress = s.status === 'preparing' ? `Preparing ${s.analysed ?? 0}/${s.total ?? 0}…` : view === 'mixed' ? 'Mixed order' : 'Showing the original order'
  return <p className="panda-mix-status"><Icon name="radio" /> Panda Mix · {label} · {progress}</p>
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
