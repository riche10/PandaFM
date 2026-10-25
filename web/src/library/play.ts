import { getAlbum, getArtistTracks, getPlaylist, type Track } from '../api/library'
import { player, radio, type QueueSource } from '../player'
import { toast } from './toasts'

// "Play" buttons on cards and headers: fetch the songs, then hand them to the
// player as its queue. Errors become a toast instead of a broken page.

async function playFrom(load: () => Promise<{ tracks: Track[] }>, emptyMessage: string, source: QueueSource, shuffle: boolean) {
  try {
    const { tracks } = await load()
    if (tracks.length === 0) toast(emptyMessage)
    else player.playCollection(tracks, { source, shuffle })
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Couldn’t start playback.', 'error')
  }
}

export const playAlbum = (id: string, name: string, shuffle = false) =>
  playFrom(() => getAlbum(id), 'This album has no songs.', { kind: 'album', id, name }, shuffle)
export const playArtist = (id: string, name: string, shuffle = false) =>
  playFrom(() => getArtistTracks(id), 'No songs found for this artist.', { kind: 'artist', id, name }, shuffle)
export const playPlaylist = (id: string, name: string, shuffle = false) =>
  playFrom(() => getPlaylist(id), 'This playlist is empty.', { kind: 'playlist', id, name }, shuffle)

/** Start Panda Radio (optionally from a song, album or artist) with a short confirmation. */
export async function startRadio(
  mode: string,
  seed: { kind: 'track' | 'album' | 'artist' | 'station'; id: string; name: string } | null,
  options: { keepCurrent?: boolean } = {},
) {
  try {
    await radio.start(mode, seed ? { kind: seed.kind, id: seed.id } : null, options)
    toast(seed ? `Panda Radio based on ${seed.name}` : 'Panda Radio started')
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Couldn’t start Panda Radio.', 'error')
  }
}

/** Play one of your saved stations (a normal Panda Radio session anchored to its genres). */
export async function startStation(station: { id: string; label: string }) {
  try {
    await radio.start('panda', { kind: 'station', id: station.id })
    toast(`${station.label} station`)
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Couldn’t start the station.', 'error') // once; no retries
  }
}
