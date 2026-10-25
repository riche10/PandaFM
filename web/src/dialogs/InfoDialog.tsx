import { useEffect, useState } from 'react'
import { apiGet } from '../api/client'
import type { Album, Track } from '../api/library'
import { GenreChips } from '../components/GenreChips'
import { formatBytes } from '../components/QualityBadge'
import { albumQuality } from '../library/qualitySummary'
import { formatLength } from '../player'
import { closeDialog } from './store'

const yesNo = (v: boolean | null | undefined) => (v === true ? 'Yes' : v === false ? 'No' : null)
const khz = (hz: number | null | undefined) => (hz ? `${(hz / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz` : null)

function Rows({ rows }: { rows: [string, string | number | null | undefined][] }) {
  return (
    <dl className="info-list">
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** What PandaFM knows about a song: only the fields that have values. */
export function TrackInfo({ track }: { track: Track }) {
  const [full, setFull] = useState<Track>(track)
  useEffect(() => {
    apiGet<{ track: Track }>(`/tracks/${encodeURIComponent(track.id)}/audio-info`).then((r) => setFull(r.track), () => undefined)
  }, [track.id])
  const q = full.quality
  return (
    <>
      <h2 className="modal-title">{full.title}</h2>
      <GenreChips tags={(full.genres ?? []).filter(Boolean).map((g) => ({ key: g.toLowerCase().replace(/-/g, ' '), name: g }))} />
      <Rows rows={[
        ['Artist', full.artist], ['Album', full.album], ['Album artist', full.album_artist ?? null], ['Year', full.year],
        ['Track', full.track_number], ['Disc', full.disc_number], ['Duration', full.duration_seconds ? formatLength(full.duration_seconds) : null],
        ['Codec', q?.codec ?? full.suffix?.toUpperCase()], ['Lossless', yesNo(q?.lossless)], ['Hi-Res', q ? (q.hi_res ? 'Yes' : 'No') : null],
        ['Sample rate', khz(full.sample_rate)], ['Bit depth', full.bit_depth ? `${full.bit_depth}-bit` : null],
        ['Channels', full.channels], ['Bitrate', full.bitrate_kbps ? `${full.bitrate_kbps} kbps` : null], ['File size', full.size_bytes ? formatBytes(full.size_bytes) : null],
      ]} />
      <div className="modal-actions">
        <button type="button" className="button" onClick={closeDialog}>Done</button>
      </div>
    </>
  )
}

/** An album's facts, with a quality line only if it's true of every song. */
export function AlbumInfo({ album }: { album: Album }) {
  return (
    <>
      <h2 className="modal-title">{album.name}</h2>
      <GenreChips tags={album.genre_tags} />
      <Rows rows={[
        ['Artist', album.artist], ['Year', album.year], ['Songs', album.tracks.length || album.track_count],
        ['Duration', album.duration_seconds ? formatLength(album.duration_seconds) : null], ['Quality', albumQuality(album.tracks.map((t) => t.quality))],
      ]} />
      <div className="modal-actions">
        <button type="button" className="button" onClick={closeDialog}>Done</button>
      </div>
    </>
  )
}
