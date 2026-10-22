import { Link } from 'react-router'
import type { AlbumSummary } from '../api/library'
import { Cover } from './Cover'

export function AlbumGrid({ albums, subtitle = 'artist' }: { albums: AlbumSummary[]; subtitle?: 'artist' | 'year' }) {
  return (
    <ul className="album-grid">
      {albums.map((album) => (
        <li key={album.id}>
          <Link to={`/albums/${encodeURIComponent(album.id)}`} className="album-card">
            <Cover coverArtId={album.cover_art_id} size={300} className="album-card-cover" />
            <span className="album-card-name">{album.name}</span>
            <span className="album-card-meta">{subtitle === 'year' ? (album.year ?? '') : album.artist}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
