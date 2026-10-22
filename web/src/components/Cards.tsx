import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { AlbumSummary, ArtistSummary, PlaylistSummary } from '../api/library'
import { playAlbum, playArtist, playPlaylist } from '../library/play'
import { Cover } from './Cover'
import { Icon, type IconName } from './Icon'

const songs = (count: number) => (count === 1 ? '1 song' : `${count} songs`)
const albums = (count: number | null) => (count === null ? 'Artist' : count === 1 ? '1 album' : `${count} albums`)

/** The white play disc that appears over artwork on hover (desktop). */
function CardPlay({ label, onPlay }: { label: string; onPlay: () => void }) {
  return (
    <button
      type="button"
      className="card-play"
      aria-label={label}
      onClick={(event) => {
        event.preventDefault()
        onPlay()
      }}
    >
      <Icon name="play" />
    </button>
  )
}

function Card({ to, art, title, subtitle, play, round }: { to: string; art: ReactNode; title: string; subtitle: ReactNode; play: ReactNode; round?: boolean }) {
  return (
    <div className="card" data-round={round ? '' : undefined}>
      <div className="card-art">
        {art}
        {play}
      </div>
      <Link to={to} className="card-title">
        {title}
      </Link>
      <span className="card-sub">{subtitle}</span>
    </div>
  )
}

export function AlbumCard({ album, subtitle = 'artist' }: { album: AlbumSummary; subtitle?: 'artist' | 'year' }) {
  return (
    <Card
      to={`/albums/${encodeURIComponent(album.id)}`}
      art={<Cover coverArtId={album.cover_art_id} size={300} className="card-cover" />}
      title={album.name}
      subtitle={subtitle === 'year' ? (album.year ?? 'Album') : album.artist}
      play={<CardPlay label={`Play ${album.name}`} onPlay={() => void playAlbum(album.id)} />}
    />
  )
}

export function ArtistCard({ artist }: { artist: ArtistSummary }) {
  return (
    <Card
      round
      to={`/artists/${encodeURIComponent(artist.id)}`}
      art={<Cover coverArtId={artist.cover_art_id} size={300} className="card-cover" />}
      title={artist.name}
      subtitle={albums(artist.album_count)}
      play={<CardPlay label={`Play ${artist.name}`} onPlay={() => void playArtist(artist.id)} />}
    />
  )
}

export function PlaylistCard({ playlist }: { playlist: PlaylistSummary }) {
  return (
    <Card
      to={`/playlists/${encodeURIComponent(playlist.id)}`}
      art={<Cover coverArtId={playlist.cover_art_id} size={300} className="card-cover" />}
      title={playlist.name}
      subtitle={songs(playlist.track_count)}
      play={<CardPlay label={`Play ${playlist.name}`} onPlay={() => void playPlaylist(playlist.id)} />}
    />
  )
}

/** Cards in a responsive grid that fills the width. */
export function CardGrid({ children }: { children: ReactNode }) {
  return <div className="card-grid">{children}</div>
}

/**
 * A home-screen row: one line of cards that scrolls sideways on phones and
 * shows as many as fit on wider screens, with "Show all" for the rest.
 */
export function Shelf({ title, to, children }: { title: string; to?: string; children: ReactNode }) {
  return (
    <section className="shelf" aria-label={title}>
      <div className="section-head">
        <h2 className="section-title">{to ? <Link to={to}>{title}</Link> : title}</h2>
        {to && (
          <Link to={to} className="show-all">
            Show all
          </Link>
        )}
      </div>
      <div className="shelf-row">{children}</div>
    </section>
  )
}

/** Large shortcut tiles at the top of Home. */
export function QuickTile({ to, icon, label, tone }: { to: string; icon: IconName; label: string; tone: string }) {
  return (
    <Link to={to} className="quick-tile">
      <span className="quick-tile-art" style={{ background: tone }}>
        <Icon name={icon} />
      </span>
      <span className="quick-tile-label">{label}</span>
    </Link>
  )
}

/** The big round play button in page headers. */
export function PlayCircle({ label, onPlay, disabled }: { label: string; onPlay: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="play-circle" aria-label={label} onClick={onPlay} disabled={disabled}>
      <Icon name="play" />
    </button>
  )
}
