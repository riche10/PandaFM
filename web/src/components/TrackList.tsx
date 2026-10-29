import { Fragment, type MouseEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { useBackLayer } from '../hooks/useBackLayer'
import { all, empty, extend, type Selection, toggle } from '../library/selection'
import { SelectionBar } from './SelectionBar'
import { Link } from 'react-router'
import type { PlaylistSummary, Track } from '../api/library'
import { formatTime, useCurrentTrack, usePlayer } from '../player'
import { Cover } from './Cover'
import { Equalizer } from './Equalizer'
import { FavoriteButton } from './FavoriteButton'
import { Icon } from './Icon'
import { OfflineMark } from './OfflineMark'
import { TrackMenu } from './TrackMenu'

interface TrackListProps {
  tracks: Track[]
  onPlay: (index: number) => void
  /** Album pages number by track and hide artwork; other lists show covers. */
  variant?: 'default' | 'album'
  /** Hide the artist on rows where it matches (album pages). */
  albumArtist?: string
  /** Show the album column on wide screens. */
  showAlbum?: boolean
  /** Enables "Remove from this playlist" in the row menus. */
  playlist?: PlaylistSummary
  header?: boolean
  /** 5.4: a short line of facts under a row (Panda Mix: "128 BPM · 8A"). */
  facts?: (track: Track, index: number) => ReactNode
  /** 5.4: something shown between this row and the one before it (Panda Mix: the transition bridge). */
  between?: (index: number) => ReactNode
}

const LONG_PRESS_MS = 500

export function TrackList({
  tracks,
  onPlay,
  variant = 'default',
  albumArtist,
  showAlbum = variant !== 'album',
  playlist,
  header = true,
  facts,
  between,
}: TrackListProps) {
  const current = useCurrentTrack()
  const status = usePlayer((s) => s.status)
  // 5.3 multi-select: a checkbox per row, Ctrl/⌘-click and Shift-click, long-press on touch, Esc to clear.
  const [selection, setSelection] = useState<Selection>(empty)
  const selecting = selection.picked.size > 0
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null)
  useEffect(() => setSelection(empty), [tracks])
  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelection(empty)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting])
  const choose = (index: number, e?: { shiftKey?: boolean }) => setSelection((s) => (e?.shiftKey ? extend(s, index) : toggle(s, index)))
  useBackLayer(selecting, () => setSelection(empty)) // Android Back leaves selection mode before navigating
  const rowPointerDown = (index: number, e: PointerEvent<HTMLLIElement>) => {
    if (e.pointerType !== 'touch') return
    const state = { fired: false, timer: setTimeout(() => { state.fired = true; choose(index) }, LONG_PRESS_MS) }
    press.current = state
  }
  const rowPointerEnd = () => {
    if (press.current) clearTimeout(press.current.timer)
  }
  const rowClickCapture = (index: number, e: MouseEvent<HTMLLIElement>) => {
    const longPressed = press.current?.fired
    press.current = null
    const target = e.target as HTMLElement
    if (target.closest('.track-select-hit')) return // the checkbox handles itself
    if (!selecting && target.closest('a, .track-favorite, .menu-button, [role="menu"]')) return // links and buttons keep their job
    if (selecting && target.closest('.track-favorite, .menu-button, [role="menu"]')) return
    if (longPressed || selecting || e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      if (!longPressed) choose(index, e)
    }
  }

  return (
    <div className={`tracks tracks--${variant}`} data-album-column={showAlbum ? '' : undefined}>
      {header && (
        <div className="tracks-head" aria-hidden="true">
          <span className="tracks-head-index">#</span>
          <span>Title</span>
          {showAlbum && <span className="tracks-head-album">Album</span>}
          <span />
          <span className="tracks-head-time">
            <Icon name="clock" />
          </span>
          <span />
        </div>
      )}
      <ol className="track-rows">
        {tracks.map((track, index) => {
          const isCurrent = current?.id === track.id
          const showArtist = variant !== 'album' || track.artist !== albumArtist
          return (
            <Fragment key={`${track.id}-${index}`}>
            {index > 0 && between?.(index)}
            <li
              className="track-row"
              aria-selected={selecting ? selection.picked.has(index) : undefined}
              data-current={isCurrent ? '' : undefined}
              data-selected={selection.picked.has(index) ? '' : undefined}
              data-selecting={selecting ? '' : undefined}
              onPointerDown={(e) => rowPointerDown(index, e)}
              onPointerUp={rowPointerEnd}
              onPointerCancel={rowPointerEnd}
              onPointerMove={(e) => e.pointerType === 'touch' && Math.abs(e.movementY) > 4 && rowPointerEnd()}
              onClickCapture={(e) => rowClickCapture(index, e)}
              onContextMenu={(e) => press.current?.fired && e.preventDefault()}
            >
              {/* 5.4: a 44×44 hit area; one tap selects (no long-press needed) and does nothing else */}
              <span
                className="track-select-hit"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  choose(index, e)
                }}
              >
                <input type="checkbox" className="track-select" checked={selection.picked.has(index)} aria-label={`Select ${track.title}`} readOnly tabIndex={0}
                  onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); choose(index, e) } }} />
              </span>
              <span className="track-index">
                {isCurrent ? (
                  <Equalizer playing={status === 'playing'} />
                ) : (
                  <span className="track-number">{variant === 'album' ? (track.track_number ?? index + 1) : index + 1}</span>
                )}
                <Icon name="play" className="icon track-hover-play" />
              </span>
              {variant !== 'album' && <Cover coverArtId={track.cover_art_id} size={96} className="track-cover" />}
              <span className="track-main">
                <button
                  type="button"
                  className="track-play"
                  onClick={() => onPlay(index)}
                  aria-label={`Play ${track.title} by ${track.artist}`}
                >
                  <span className="track-title">{track.title}</span>
                </button>
                <OfflineMark trackId={track.id} />
                {facts && <span className="track-facts">{facts(track, index)}</span>}
                {showArtist && (
                  <span className="track-sub">
                    {track.artist_id ? (
                      <Link to={`/artists/${encodeURIComponent(track.artist_id)}`}>{track.artist}</Link>
                    ) : (
                      track.artist
                    )}
                  </span>
                )}
              </span>
              {showAlbum && (
                <span className="track-album">
                  {track.album_id && track.album ? (
                    <Link to={`/albums/${encodeURIComponent(track.album_id)}`}>{track.album}</Link>
                  ) : (
                    track.album
                  )}
                </span>
              )}
              <FavoriteButton kind="track" id={track.id} fromServer={track.favorite} label={track.title} className="track-favorite" />
              <span className="track-duration">{formatTime(track.duration_seconds)}</span>
              <TrackMenu
                track={track}
                onPlay={() => onPlay(index)}
                inPlaylist={playlist ? { playlist, index } : undefined}
              />
            </li>
            </Fragment>
          )
        })}
      </ol>
      <SelectionBar selection={selection} tracks={tracks} playlist={playlist} onClear={() => setSelection(empty)} onSelectAll={() => setSelection(all(tracks.length))} />
    </div>
  )
}
