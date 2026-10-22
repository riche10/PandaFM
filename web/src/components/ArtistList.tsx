import { Link } from 'react-router'
import type { ArtistSummary } from '../api/library'
import { Cover } from './Cover'

export const albumCount = (count: number | null) =>
  count === null ? '' : count === 1 ? '1 album' : `${count} albums`

export function ArtistList({ artists }: { artists: ArtistSummary[] }) {
  return (
    <ul className="artist-list">
      {artists.map((artist) => (
        <li key={artist.id}>
          <Link to={`/artists/${encodeURIComponent(artist.id)}`} className="artist-row">
            <Cover coverArtId={artist.cover_art_id} size={96} className="artist-avatar" />
            <span className="artist-name">{artist.name}</span>
            <span className="artist-meta">{albumCount(artist.album_count)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
