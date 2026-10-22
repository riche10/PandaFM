import type { Track } from '../api/library'

// PandaFM's one shared play queue, as plain data plus pure functions.
//
// Every way of playing music ends up here: an album, a playlist, search
// results, shuffle, "Play next", and later Panda Radio and Panda DJ. Nothing
// in this file touches audio or React; the player store applies these
// functions and tells the AudioEngine what to load.
//
// Items carry their own uid, so the same song can sit in the queue twice
// (a playlist with duplicates, "Play next" twice) and still be moved or
// removed unambiguously. `origin` separates the collection that was started
// ("context") from songs the listener added by hand ("manual"); manual songs
// play first and are never reshuffled, the way music apps usually behave.

export type RepeatMode = 'off' | 'all' | 'one'

export interface QueueSource {
  kind: 'album' | 'playlist' | 'artist' | 'favorites' | 'search' | 'songs' | 'tracks'
  name: string
  id?: string
}

export interface QueueItem {
  uid: string
  track: Track
  origin: 'context' | 'manual'
}

export interface QueueState {
  items: QueueItem[]
  /** Position of the current item in `items`; -1 when the queue is empty. */
  index: number
  source: QueueSource | null
  shuffle: boolean
  /** While shuffled: the collection's items in their original order, to restore later. */
  ordered: QueueItem[] | null
  repeat: RepeatMode
}

export const emptyQueue: QueueState = {
  items: [],
  index: -1,
  source: null,
  shuffle: false,
  ordered: null,
  repeat: 'off',
}

export type Random = () => number

let counter = 0
const uid = () => `q${Date.now().toString(36)}${(counter++).toString(36)}`

const wrap = (tracks: Track[], origin: QueueItem['origin']): QueueItem[] =>
  tracks.map((track) => ({ uid: uid(), track, origin }))

/** Fisher–Yates. */
function shuffled<T>(list: T[], random: Random): T[] {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export const current = (state: QueueState): QueueItem | null => state.items[state.index] ?? null
export const upcoming = (state: QueueState): QueueItem[] => state.items.slice(state.index + 1)

/** Songs added by hand that are waiting to play ("Next in queue"). */
export function manualUpcoming(state: QueueState): QueueItem[] {
  const result: QueueItem[] = []
  for (const item of upcoming(state)) {
    if (item.origin !== 'manual') break
    result.push(item)
  }
  return result
}

/** The rest of the collection ("Next from: <source>"). */
export const contextUpcoming = (state: QueueState): QueueItem[] => upcoming(state).slice(manualUpcoming(state).length)

/**
 * Start a collection. With shuffle, the chosen song (or a random one when
 * startIndex is omitted) plays first and the rest follow in random order.
 */
export function load(
  state: QueueState,
  tracks: Track[],
  { startIndex, source = null, shuffle = state.shuffle, random = Math.random }: {
    startIndex?: number
    source?: QueueSource | null
    shuffle?: boolean
    random?: Random
  } = {},
): QueueState {
  if (tracks.length === 0) return state
  const items = wrap(tracks, 'context')
  const start =
    startIndex !== undefined
      ? Math.min(Math.max(0, startIndex), items.length - 1)
      : shuffle
        ? Math.floor(random() * items.length)
        : 0
  const base: QueueState = { ...state, items, index: start, source, shuffle: false, ordered: null }
  return shuffle ? setShuffle(base, true, random) : base
}

/** Insert songs to play right after the current one. */
export function playNext(state: QueueState, tracks: Track[]): QueueState {
  if (tracks.length === 0) return state
  if (state.index < 0) return { ...state, items: wrap(tracks, 'manual'), index: 0 }
  const at = state.index + 1
  return { ...state, items: [...state.items.slice(0, at), ...wrap(tracks, 'manual'), ...state.items.slice(at)] }
}

/** Add songs after everything already queued by hand, before the rest of the collection. */
export function addToQueue(state: QueueState, tracks: Track[]): QueueState {
  if (tracks.length === 0) return state
  if (state.index < 0) return { ...state, items: wrap(tracks, 'manual'), index: 0 }
  const at = state.index + 1 + manualUpcoming(state).length
  return { ...state, items: [...state.items.slice(0, at), ...wrap(tracks, 'manual'), ...state.items.slice(at)] }
}

/** Remove a song that isn't the one playing. */
export function remove(state: QueueState, itemUid: string): QueueState {
  const at = state.items.findIndex((item) => item.uid === itemUid)
  if (at < 0 || at === state.index) return state
  return {
    ...state,
    items: state.items.filter((item) => item.uid !== itemUid),
    index: at < state.index ? state.index - 1 : state.index,
    ordered: state.ordered?.filter((item) => item.uid !== itemUid) ?? null,
  }
}

/** Drop everything after the current song. */
export function clearUpcoming(state: QueueState, which: 'all' | 'manual' = 'all'): QueueState {
  const drop = new Set((which === 'manual' ? manualUpcoming(state) : upcoming(state)).map((item) => item.uid))
  return {
    ...state,
    items: state.items.filter((item) => !drop.has(item.uid)),
    ordered: state.ordered?.filter((item) => !drop.has(item.uid)) ?? null,
  }
}

/** Make an item current (the store then starts it). */
export function jumpTo(state: QueueState, itemUid: string): QueueState {
  const at = state.items.findIndex((item) => item.uid === itemUid)
  return at < 0 ? state : { ...state, index: at }
}

/** Move an upcoming item one place earlier or later, among upcoming items only. */
export function move(state: QueueState, itemUid: string, direction: -1 | 1): QueueState {
  const at = state.items.findIndex((item) => item.uid === itemUid)
  const to = at + direction
  if (at <= state.index || to <= state.index || to >= state.items.length) return state
  const items = [...state.items]
  ;[items[at], items[to]] = [items[to], items[at]]
  // An item moved into the hand-picked block becomes hand-picked, and vice versa,
  // so the "Next in queue" / "Next from" split always matches what plays.
  const neighbour = items[at]
  items[to] = { ...items[to], origin: neighbour.origin }
  return { ...state, items }
}

/**
 * Shuffle keeps the current song playing and in place, keeps hand-picked
 * songs next, and randomises the rest of the collection (played or not),
 * each song once. Turning it off restores the collection's own order around
 * the current song.
 */
export function setShuffle(state: QueueState, on: boolean, random: Random = Math.random): QueueState {
  if (on === state.shuffle || state.index < 0) return { ...state, shuffle: on && state.index >= 0 }
  const now = state.items[state.index]
  const manual = manualUpcoming(state)
  const manualIds = new Set(manual.map((item) => item.uid))

  if (on) {
    const context = state.items.filter((item) => item.origin === 'context')
    const rest = context.filter((item) => item.uid !== now.uid && !manualIds.has(item.uid))
    return {
      ...state,
      items: [now, ...manual, ...shuffled(rest, random)],
      index: 0,
      shuffle: true,
      ordered: context,
    }
  }

  // Songs moved into the hand-picked block stay there, so leave them out here.
  const ordered = (state.ordered ?? []).filter((item) => !manualIds.has(item.uid))
  const at = ordered.findIndex((item) => item.uid === now.uid)
  if (at < 0) {
    // The current song was hand-picked: continue with the collection from the top.
    return { ...state, items: [now, ...manual, ...ordered], index: 0, shuffle: false, ordered: null }
  }
  return {
    ...state,
    items: [...ordered.slice(0, at), now, ...manual, ...ordered.slice(at + 1)],
    index: at,
    shuffle: false,
    ordered: null,
  }
}

export function cycleRepeat(state: QueueState): QueueState {
  const order: RepeatMode[] = ['off', 'all', 'one']
  return { ...state, repeat: order[(order.indexOf(state.repeat) + 1) % order.length] }
}

/** Where "Next" goes: the next item, the start again with repeat-all, or nowhere. */
export function nextIndex(state: QueueState): number | null {
  if (state.index < 0) return null
  if (state.index + 1 < state.items.length) return state.index + 1
  return state.repeat === 'all' && state.items.length > 0 ? 0 : null
}

/** Where "Previous" goes when it isn't just restarting the current song. */
export function previousIndex(state: QueueState): number | null {
  if (state.index > 0) return state.index - 1
  return state.repeat === 'all' && state.items.length > 1 ? state.items.length - 1 : null
}
