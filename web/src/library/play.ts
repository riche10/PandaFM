import { getAlbum, getArtistTracks, getPlaylist, type Track } from '../api/library'
import { player } from '../player'
import { toast } from './toasts'

// "Play" buttons on cards and headers: fetch the songs, then hand them to the
// player as its queue. Errors become a toast instead of a broken page.

async function playFrom(load: () => Promise<{ tracks: Track[] }>, emptyMessage: string) {
  try {
    const { tracks } = await load()
    if (tracks.length === 0) toast(emptyMessage)
    else player.playTracks(tracks, 0)
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Couldn’t start playback.', 'error')
  }
}

export const playAlbum = (id: string) => playFrom(() => getAlbum(id), 'This album has no songs.')
export const playArtist = (id: string) => playFrom(() => getArtistTracks(id), 'No songs found for this artist.')
export const playPlaylist = (id: string) => playFrom(() => getPlaylist(id), 'This playlist is empty.')
