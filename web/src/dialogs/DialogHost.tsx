import { type FormEvent, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { PlaylistSummary, Track } from '../api/library'
import { Cover } from '../components/Cover'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { playlists, toast, usePlaylists } from '../library'
import { DownloadDialog } from './DownloadDialog'
import { closeDialog, type DialogRequest, openDialog, useDialog } from './store'

const songs = (count: number) => (count === 1 ? '1 song' : `${count} songs`)
const messageOf = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong.')

export function DialogHost() {
  const request = useDialog()
  return (
    <Modal open={request !== null} onClose={closeDialog} label={request ? labelFor(request) : 'Dialog'}>
      {request?.type === 'add-to-playlist' && <AddToPlaylist tracks={request.tracks} />}
      {request?.type === 'new-playlist' && <PlaylistNameForm mode="create" tracks={request.tracks} />}
      {request?.type === 'rename-playlist' && <PlaylistNameForm mode="rename" playlist={request.playlist} />}
      {request?.type === 'download' && <DownloadDialog target={request.target} />}
      {request?.type === 'why' && <WhyThisSong track={request.track} reasons={request.reasons} modeLabel={request.modeLabel} />}
      {request?.type === 'delete-playlist' && (
        <DeletePlaylist playlist={request.playlist} onDeleted={request.onDeleted} />
      )}
    </Modal>
  )
}

function labelFor(request: DialogRequest): string {
  switch (request.type) {
    case 'add-to-playlist':
      return 'Add to playlist'
    case 'new-playlist':
      return 'New playlist'
    case 'rename-playlist':
      return 'Rename playlist'
    case 'delete-playlist':
      return 'Delete playlist'
    case 'why':
      return 'Why this song?'
    case 'download':
      return 'Download'
  }
}

function AddToPlaylist({ tracks }: { tracks: Track[] }) {
  const all = usePlaylists()
  const editable = all.filter((p) => !p.readonly)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void playlists().load()
  }, [])

  const add = async (playlist: PlaylistSummary) => {
    setBusy(playlist.id)
    try {
      await playlists().addTracks(
        playlist.id,
        tracks.map((t) => t.id),
      )
      toast(`Added ${tracks.length === 1 ? `“${tracks[0].title}”` : songs(tracks.length)} to ${playlist.name}`)
      closeDialog()
    } catch (err) {
      toast(messageOf(err), 'error')
      setBusy(null)
    }
  }

  return (
    <>
      <h2 className="modal-title">Add to playlist</h2>
      <p className="modal-subtitle">
        {tracks.length === 1 ? `${tracks[0].title} · ${tracks[0].artist}` : songs(tracks.length)}
      </p>
      <ul className="choice-list">
        <li>
          <button type="button" className="choice" onClick={() => openDialog({ type: 'new-playlist', tracks })}>
            <span className="choice-art choice-art--new">
              <Icon name="plus" />
            </span>
            <span className="choice-name">New playlist</span>
          </button>
        </li>
        {editable.map((playlist) => (
          <li key={playlist.id}>
            <button type="button" className="choice" disabled={busy !== null} onClick={() => void add(playlist)}>
              <Cover coverArtId={playlist.cover_art_id} size={96} className="choice-art" />
              <span className="choice-name">{playlist.name}</span>
              <span className="choice-meta">{busy === playlist.id ? 'Adding…' : songs(playlist.track_count)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        <button type="button" className="button button--quiet" onClick={closeDialog}>
          Cancel
        </button>
      </div>
    </>
  )
}

type NameFormProps =
  | { mode: 'create'; tracks: Track[]; playlist?: undefined }
  | { mode: 'rename'; playlist: PlaylistSummary; tracks?: undefined }

function PlaylistNameForm(props: NameFormProps) {
  const navigate = useNavigate()
  const [name, setName] = useState(props.mode === 'rename' ? props.playlist.name : '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      if (props.mode === 'create') {
        const created = await playlists().create(
          trimmed,
          props.tracks.map((t) => t.id),
        )
        toast(props.tracks.length ? `Created ${created.name} with ${songs(props.tracks.length)}` : `Created ${created.name}`)
        closeDialog()
        if (!props.tracks.length) navigate(`/playlists/${encodeURIComponent(created.id)}`)
      } else {
        await playlists().rename(props.playlist.id, trimmed)
        toast('Playlist renamed')
        closeDialog()
      }
    } catch (err) {
      setError(messageOf(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)}>
      <h2 className="modal-title">{props.mode === 'create' ? 'New playlist' : 'Rename playlist'}</h2>
      {props.mode === 'create' && props.tracks.length > 0 && (
        <p className="modal-subtitle">Starts with {props.tracks.length === 1 ? `“${props.tracks[0].title}”` : songs(props.tracks.length)}</p>
      )}
      <label className="field">
        <span className="field-label">Name</span>
        <input
          className="field-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          autoFocus
          placeholder="My playlist"
          enterKeyHint="done"
        />
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="button button--quiet" onClick={closeDialog}>
          Cancel
        </button>
        <button type="submit" className="button" disabled={busy || !name.trim()}>
          {props.mode === 'create' ? (busy ? 'Creating…' : 'Create') : busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

function WhyThisSong({ track, reasons, modeLabel }: { track: Track; reasons: string[]; modeLabel: string | null }) {
  return (
    <>
      <h2 className="modal-title">Why this song?</h2>
      <p className="modal-subtitle">
        {track.title} · {track.artist}
        {modeLabel ? ` · chosen by ${modeLabel}` : ''}
      </p>
      <ul className="why-list">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <div className="modal-actions">
        <button type="button" className="button" onClick={closeDialog} autoFocus>
          Got it
        </button>
      </div>
    </>
  )
}

function DeletePlaylist({ playlist, onDeleted }: { playlist: PlaylistSummary; onDeleted?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    setBusy(true)
    try {
      await playlists().remove(playlist.id)
      toast(`Deleted ${playlist.name}`)
      closeDialog()
      onDeleted?.()
    } catch (err) {
      setError(messageOf(err))
      setBusy(false)
    }
  }

  return (
    <>
      <h2 className="modal-title">Delete “{playlist.name}”?</h2>
      <p className="modal-subtitle">
        The playlist is removed from Navidrome. The songs stay in your library.
      </p>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="button button--quiet" onClick={closeDialog} autoFocus>
          Cancel
        </button>
        <button type="button" className="button button--danger" disabled={busy} onClick={() => void confirm()}>
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </>
  )
}
