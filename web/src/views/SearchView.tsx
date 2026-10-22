import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { searchLibrary } from '../api/library'
import { AlbumCard, ArtistCard, CardGrid, QuickTile } from '../components/Cards'
import { Icon } from '../components/Icon'
import { EmptyState, ErrorNotice, Loading } from '../components/States'
import { TrackList } from '../components/TrackList'
import { useApi } from '../hooks/useApi'
import { useIsDesktop } from '../hooks/useMediaQuery'
import { player } from '../player'

const SEARCH_DELAY_MS = 200
const SONGS_PREVIEW = 5

export function SearchView() {
  // The query lives in the URL (?q=), so Back, refresh and links keep it.
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const [draft, setDraft] = useState(query)
  const input = useRef<HTMLInputElement>(null)
  const isDesktop = useIsDesktop()

  // When the URL changes from outside (the back button), show that query.
  const [shownQuery, setShownQuery] = useState(query)
  if (query !== shownQuery) {
    setShownQuery(query)
    if (draft.trim() !== query) setDraft(query)
  }

  const applyQuery = (text: string) => {
    const next = text.trim()
    // Refining a search replaces history; starting one adds an entry.
    setParams(next ? { q: next } : {}, { replace: query !== '' })
  }

  useEffect(() => {
    if (draft.trim() === query) return
    const timer = setTimeout(() => applyQuery(draft), SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
    // applyQuery only depends on `query`, already listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, query])

  useEffect(() => {
    // Ready to type on arrival; on phones only when there's no search yet.
    if (isDesktop || !query) input.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    applyQuery(draft)
    input.current?.blur() // close the phone keyboard
  }

  return (
    <div className="page page--search">
      <form role="search" className="search" onSubmit={submit}>
        <Icon name="search" />
        <input
          ref={input}
          type="search"
          className="search-input"
          placeholder="What do you want to hear?"
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
      {query ? <SearchResults key={query} query={query} /> : <SearchStart />}
    </div>
  )
}

function SearchStart() {
  return (
    <>
      <h1 className="page-title page-title--section">Browse your library</h1>
      <nav className="quick-grid" aria-label="Browse">
        <QuickTile to="/library/albums" icon="album" label="Albums" tone="linear-gradient(135deg, #2c3a4a, #161c24)" />
        <QuickTile to="/library/artists" icon="artist" label="Artists" tone="linear-gradient(135deg, #2a3d33, #151f1a)" />
        <QuickTile to="/library/songs" icon="music" label="Songs" tone="linear-gradient(135deg, #3a2f4a, #1c1725)" />
        <QuickTile to="/library/playlists" icon="playlist" label="Playlists" tone="linear-gradient(135deg, #46332a, #221915)" />
        <QuickTile to="/favorites" icon="heart" label="Favorites" tone="linear-gradient(135deg, #4a2a3a, #23161d)" />
        <QuickTile to="/library/albums?sort=random" icon="shuffle" label="Random albums" tone="linear-gradient(135deg, #3d3a26, #1f1d14)" />
      </nav>
    </>
  )
}

function SearchResults({ query }: { query: string }) {
  const [resource, retry] = useApi(`search:${query}`, (signal) => searchLibrary(query, signal))
  const [allSongs, setAllSongs] = useState(false)

  if (resource.state === 'error') return <ErrorNotice error={resource.error} onRetry={retry} />
  const results = resource.state === 'ready' ? resource.data : resource.previous
  if (!results) return <Loading label="Searching…" />

  const nothing = !results.tracks.length && !results.albums.length && !results.artists.length
  if (nothing && resource.state === 'ready') {
    return (
      <EmptyState icon="search" title={`No results for “${query}”`}>
        <p>Check the spelling, or try fewer words: part of a song title, an album or an artist.</p>
      </EmptyState>
    )
  }

  const songs = allSongs ? results.tracks : results.tracks.slice(0, SONGS_PREVIEW)
  return (
    <div className="results" aria-busy={resource.state === 'loading'}>
      {results.tracks.length > 0 && (
        <section className="shelf" aria-label="Songs">
          <div className="section-head">
            <h2 className="section-title">Songs</h2>
            {results.tracks.length > SONGS_PREVIEW && (
              <button type="button" className="show-all" onClick={() => setAllSongs(!allSongs)}>
                {allSongs ? 'Show fewer' : `Show all ${results.tracks.length}`}
              </button>
            )}
          </div>
          <TrackList tracks={songs} onPlay={(i) => player.playTracks(results.tracks, i)} header={false} />
        </section>
      )}
      {results.artists.length > 0 && (
        <section className="shelf" aria-label="Artists">
          <h2 className="section-title">Artists</h2>
          <CardGrid>
            {results.artists.map((artist) => (
              <ArtistCard key={artist.id} artist={artist} />
            ))}
          </CardGrid>
        </section>
      )}
      {results.albums.length > 0 && (
        <section className="shelf" aria-label="Albums">
          <h2 className="section-title">Albums</h2>
          <CardGrid>
            {results.albums.map((album) => (
              <AlbumCard key={album.id} album={album} />
            ))}
          </CardGrid>
        </section>
      )}
    </div>
  )
}
