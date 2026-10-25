import { useParams } from 'react-router'
import { exploreApi } from '../api/explore'
import { AlbumCard, ArtistCard, CardGrid, Shelf } from '../components/Cards'
import { DetailHero } from '../components/DetailHero'
import { GenreArt } from '../components/GenreArt'
import { GenreChips } from '../components/GenreChips'
import { Icon } from '../components/Icon'
import { MenuButton, MenuItem } from '../components/Menu'
import { EmptyState, ErrorNotice, Loading } from '../components/States'
import { TrackList } from '../components/TrackList'
import { openDialog } from '../dialogs/store'
import { useApi } from '../hooks/useApi'
import { usePaged } from '../hooks/usePaged'
import { toast } from '../library'
import { startRadio } from '../library/play'
import { usePresets } from '../library/presets'
import { player } from '../player'
import { LoadMore } from './LibraryView'

/** A genre from your library: its artists, albums and songs, and Genre Radio. */
export function GenreView() {
  const { genreKey = '' } = useParams()
  const [resource, retry] = useApi(`genre:${genreKey}`, (signal) => exploreApi.genre(genreKey, signal))
  const albums = usePaged(`genre-albums:${genreKey}`, (offset, size, signal) => exploreApi.albums({ genre: genreKey }, 'name', offset, size, signal).then((r) => r.albums), 24)
  const songs = usePaged(`genre-songs:${genreKey}`, (offset, size, signal) => exploreApi.tracks({ genre: genreKey }, 'artist', offset, size, signal).then((r) => r.tracks), 50)
  const { presets } = usePresets()

  if (resource.state === 'error') return <div className="page"><ErrorNotice error={resource.error} onRetry={retry} /></div>
  if (resource.state === 'loading') return <div className="page"><Loading label="Loading genre…" /></div>
  const { genre: g, artists, related, tags } = resource.data
  const play = async (shuffle: boolean) => {
    const r = await exploreApi.tracks({ genre: genreKey }, shuffle ? 'random' : 'artist', 0, 200).catch(() => null)
    if (!r?.tracks.length) return toast('Couldn’t load the songs.', 'error')
    player.playCollection(r.tracks, { source: { kind: 'tracks', name: g.name } })
  }
  const radio = (preset: string) => void startRadio(preset, { kind: 'genre', id: g.key, name: g.name })

  return (
    <div className="page page--genre">
      <DetailHero
        color={null}
        art={<GenreArt covers={g.cover_art_ids} className="hero-art" />}
        kind="Genre"
        title={g.name}
        meta={`${g.songs} songs · ${g.albums} albums · ${g.artists} artists`}
        actions={
          <div className="hero-actions">
            <button type="button" className="icon-button icon-button--large play-circle" aria-label={`Play ${g.name}`} onClick={() => void play(false)}>
              <Icon name="play" />
            </button>
            <button type="button" className="icon-button icon-button--large" aria-label={`Shuffle ${g.name}`} onClick={() => void play(true)}>
              <Icon name="shuffle" />
            </button>
            <button type="button" className="button button--quiet" onClick={() => radio('panda')}>
              <Icon name="radio" /> {g.name} Radio
            </button>
            <MenuButton label={`More for ${g.name}`}>
              {(close) => (
                <>
                  {(presets ?? []).filter((p) => p.id !== 'panda').map((p) => (
                    <MenuItem key={p.id} icon="radio" label={`${g.name} Radio · ${p.name}`} onSelect={() => { close(); radio(p.id) }} />
                  ))}
                  <MenuItem icon="plus" label="Save as station" onSelect={() => { close(); openDialog({ type: 'station', station: null, prefill: { name: g.name, genres: tags } }) }} />
                </>
              )}
            </MenuButton>
          </div>
        }
      />
      {artists.length > 0 && (
        <Shelf title="Artists">
          {artists.map((a) => <ArtistCard key={a.id} artist={{ id: a.id, name: a.name, cover_art_id: a.cover_art_id, album_count: null, favorite: false }} />)}
        </Shelf>
      )}
      <section className="shelf" aria-labelledby="genre-albums">
        <h2 id="genre-albums" className="section-title">Albums</h2>
        {albums.state === 'loading' ? <Loading label="Loading albums…" /> : (
          <>
            <CardGrid>{albums.items.map((a) => <AlbumCard key={a.id} album={a} />)}</CardGrid>
            <LoadMore visible={albums.hasMore} busy={albums.loadingMore} onClick={albums.loadMore} />
          </>
        )}
      </section>
      <section className="shelf" aria-labelledby="genre-songs">
        <h2 id="genre-songs" className="section-title">Songs</h2>
        {songs.state === 'loading' ? <Loading label="Loading songs…" /> : songs.items.length === 0 ? <EmptyState icon="music" title="No songs" /> : (
          <>
            <TrackList tracks={songs.items} onPlay={(i) => player.playCollection(songs.items, { startIndex: i, source: { kind: 'tracks', name: g.name } })} />
            <LoadMore visible={songs.hasMore} busy={songs.loadingMore} onClick={songs.loadMore} />
          </>
        )}
      </section>
      {related.length > 0 && (
        <section className="shelf" aria-labelledby="genre-related">
          <h2 id="genre-related" className="section-title">Close to {g.name}</h2>
          <GenreChips tags={related} limit={8} label={`Close to ${g.name}`} />
        </section>
      )}
    </div>
  )
}
