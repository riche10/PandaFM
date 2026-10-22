import { type FormEvent, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { type AlbumListKind, listAlbums, searchLibrary } from '../api/library'
import { AlbumGrid } from '../components/AlbumGrid'
import { ArtistList } from '../components/ArtistList'
import { ErrorNotice } from '../components/ErrorNotice'
import { Icon } from '../components/Icon'
import { TrackList } from '../components/TrackList'
import { Wordmark } from '../components/Wordmark'
import { useApi } from '../hooks/useApi'
import { player } from '../player'

const BROWSE_LISTS: { kind: AlbumListKind; label: string }[] = [
  { kind: 'newest', label: 'Recently added' },
  { kind: 'random', label: 'Random' },
  { kind: 'alphabetical', label: 'A–Z' },
]

const SEARCH_DELAY_MS = 250

function browseKind(value: string | null): AlbumListKind {
  return BROWSE_LISTS.some((item) => item.kind === value) ? (value as AlbumListKind) : 'newest'
}

export function HomeView() {
  // The query lives in the URL (?q=), so back, refresh and links keep it.
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const list = browseKind(params.get('list'))
  const [draft, setDraft] = useState(query)

  // When the URL changes from outside (the back button), show that query.
  const [shownQuery, setShownQuery] = useState(query)
  if (query !== shownQuery) {
    setShownQuery(query)
    if (draft.trim() !== query) setDraft(query)
  }

  const applyQuery = (text: string) => {
    const next = text.trim()
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev)
        if (next) updated.set('q', next)
        else updated.delete('q')
        return updated
      },
      // Refining a search replaces history; starting one adds an entry.
      { replace: query !== '' },
    )
  }

  useEffect(() => {
    if (draft.trim() === query) return
    const timer = setTimeout(() => applyQuery(draft), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
    // applyQuery only depends on `query`, already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, query])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    applyQuery(draft)
    ;(document.activeElement as HTMLElement | null)?.blur() // close the phone keyboard
  }

  const chooseList = (kind: AlbumListKind) =>
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev)
        updated.set('list', kind)
        return updated
      },
      { replace: true },
    )

  return (
    <main className="page home">
      <Wordmark size="small" />
      <form role="search" className="search" onSubmit={submit}>
        <Icon name="search" />
        <input
          type="search"
          className="search-input"
          placeholder="Songs, albums or artists"
          aria-label="Search your library"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        {draft && (
          <button type="button" className="icon-button" aria-label="Clear search" onClick={() => setDraft('')}>
            <Icon name="close" />
          </button>
        )}
      </form>

      {query ? <SearchResultsView query={query} /> : <Browse list={list} onChoose={chooseList} />}
    </main>
  )
}

function SearchResultsView({ query }: { query: string }) {
  const [resource, retry] = useApi(`search:${query}`, (signal) => searchLibrary(query, signal))

  if (resource.state === 'error') return <ErrorNotice error={resource.error} onRetry={retry} />
  const results = resource.state === 'ready' ? resource.data : resource.previous
  if (!results) return <p className="hint">Searching…</p>

  const nothing = !results.tracks.length && !results.albums.length && !results.artists.length
  return (
    <div className="results" aria-busy={resource.state === 'loading'}>
      {nothing && resource.state === 'ready' && (
        <p className="hint">
          Nothing in your library matches “{query}”. Try fewer words, or part of a title or artist name.
        </p>
      )}
      {results.tracks.length > 0 && (
        <section aria-labelledby="songs-title">
          <h2 id="songs-title" className="section-title">
            Songs
          </h2>
          <TrackList tracks={results.tracks} variant="search" onPlay={(i) => player.playTracks(results.tracks, i)} />
        </section>
      )}
      {results.albums.length > 0 && (
        <section aria-labelledby="albums-title">
          <h2 id="albums-title" className="section-title">
            Albums
          </h2>
          <AlbumGrid albums={results.albums} />
        </section>
      )}
      {results.artists.length > 0 && (
        <section aria-labelledby="artists-title">
          <h2 id="artists-title" className="section-title">
            Artists
          </h2>
          <ArtistList artists={results.artists} />
        </section>
      )}
    </div>
  )
}

function Browse({ list, onChoose }: { list: AlbumListKind; onChoose: (kind: AlbumListKind) => void }) {
  const [resource, retry] = useApi(`albums:${list}`, (signal) => listAlbums(list, signal))

  return (
    <section aria-labelledby="browse-title">
      <div className="section-head">
        <h2 id="browse-title" className="section-title">
          Albums
        </h2>
        <Link to="/artists" className="text-button">
          All artists
        </Link>
      </div>
      <div className="chips" role="group" aria-label="Show albums">
        {BROWSE_LISTS.map(({ kind, label }) => (
          <button
            key={kind}
            type="button"
            className="chip"
            aria-pressed={kind === list}
            // Tapping Random again deals a new set.
            onClick={() => (kind === list ? kind === 'random' && retry() : onChoose(kind))}
          >
            {label}
          </button>
        ))}
      </div>
      {resource.state === 'error' ? (
        <ErrorNotice error={resource.error} onRetry={retry} />
      ) : resource.state === 'loading' ? (
        <p className="hint">Loading albums…</p>
      ) : resource.data.albums.length === 0 ? (
        <p className="hint">
          Navidrome hasn’t found any albums yet. If you just added music, wait for its next library scan.
        </p>
      ) : (
        <AlbumGrid albums={resource.data.albums} />
      )}
    </section>
  )
}
