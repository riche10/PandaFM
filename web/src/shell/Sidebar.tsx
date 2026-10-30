import { useEffect } from 'react'
import { NavLink } from 'react-router'
import { Cover } from '../components/Cover'
import { Icon, type IconName } from '../components/Icon'
import { Wordmark } from '../components/Wordmark'
import { isNative } from '../platform/state'
import { openDialog } from '../dialogs/store'
import { playlists, usePlaylists, usePlaylistsStatus } from '../library'

const MAIN_NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/search', label: 'Search', icon: 'search' },
  { to: '/library', label: 'Library', icon: 'library' },
]

export function Sidebar() {
  const all = usePlaylists()
  const status = usePlaylistsStatus()

  useEffect(() => {
    void playlists().load()
  }, [])

  return (
    <nav className="sidebar" aria-label="Main">
      <NavLink to="/" className="sidebar-brand" aria-label="PandaFM home">
        <Wordmark size="small" heading={false} />
      </NavLink>

      <ul className="nav-list">
        {MAIN_NAV.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.end} className="nav-link">
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>

      <ul className="nav-list nav-list--secondary">
        {isNative() && (
          <li>
            <NavLink to="/offline" className="nav-link">
              <Icon name="downloaded" />
              <span>Downloaded</span>
            </NavLink>
          </li>
        )}
        <li>
          <NavLink to="/settings" className="nav-link">
            <Icon name="settings" />
            <span>Settings</span>
          </NavLink>
        </li>
        <li>
          <NavLink to="/favorites" className="nav-link">
            <span className="nav-tile nav-tile--favorites">
              <Icon name="paw" />
            </span>
            <span>Favorites</span>
          </NavLink>
        </li>
      </ul>

      <div className="sidebar-playlists">
        <div className="sidebar-heading">
          <NavLink to="/library/playlists" className="sidebar-heading-link">
            Playlists
          </NavLink>
          <button
            type="button"
            className="icon-button icon-button--small"
            aria-label="New playlist"
            onClick={() => openDialog({ type: 'new-playlist', tracks: [] })}
          >
            <Icon name="plus" />
          </button>
        </div>
        <ul className="nav-list nav-list--playlists">
          {all.map((playlist) => (
            <li key={playlist.id}>
              <NavLink to={`/playlists/${encodeURIComponent(playlist.id)}`} className="nav-link nav-link--playlist">
                <Cover coverArtId={playlist.cover_art_id} size={96} className="nav-tile" />
                <span className="nav-text">{playlist.name}</span>
              </NavLink>
            </li>
          ))}
        </ul>
        {status === 'ready' && all.length === 0 && (
          <button type="button" className="sidebar-new" onClick={() => openDialog({ type: 'new-playlist', tracks: [] })}>
            <Icon name="plus" />
            New playlist
          </button>
        )}
      </div>
    </nav>
  )
}
