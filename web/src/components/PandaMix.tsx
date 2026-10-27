import { useEffect, useState } from 'react'
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

/** Playlist pages: play this playlist as a Panda Mix (normal Play stays as it is). */
export function PandaMixButton({ playlist, source }: { playlist: Playlist; source: QueueSource }) {
  const start = (mode: MixMode) =>
    player.playCollection(playlist.tracks, { source: { ...source, mix: { mode, playlistId: playlist.id } }, shuffle: false })
  const prepare = () => {
    void platform.player?.prepareMixOffline({ tracks: JSON.stringify(playlist.tracks), playlistId: playlist.id, mode: 'auto' })
    toast('Panda is preparing this playlist’s transitions for offline listening.')
  }
  return (
    <>
      <button type="button" className="button button--quiet panda-mix-button" disabled={playlist.tracks.length < 2} onClick={() => start('auto')}>
        <Icon name="radio" /> Panda Mix
      </button>
      <MenuButton label="Panda Mix style">
        {(close) => (
          <>
            {MODES.map((m) => <MenuItem key={m.id} icon="radio" label={`Panda Mix · ${m.label}`} onSelect={() => { close(); start(m.id) }} />)}
            {isNative() && <MenuItem icon="download" label="Prepare Panda Mix (offline)" onSelect={() => { close(); prepare() }} />}
          </>
        )}
      </MenuButton>
    </>
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
