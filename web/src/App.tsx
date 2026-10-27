import { Navigate, Route, Routes } from 'react-router'
import { isNative } from './platform/state'
import { AndroidBack } from './shell/AndroidBack'
import { AppShell } from './shell/AppShell'
import { ConnectionGate } from './shell/ConnectionGate'
import { OfflineView } from './views/OfflineView'
import { GenreView } from './views/GenreView'
import { DecadeView } from './views/DecadeView'
import { CollectionView } from './views/CollectionView'
import { SettingsView } from './views/SettingsView'
import { AlbumView } from './views/AlbumView'
import { ArtistView } from './views/ArtistView'
import { FavoritesView } from './views/FavoritesView'
import { HomeView } from './views/HomeView'
import { LibraryView } from './views/LibraryView'
import { NotFoundView } from './views/NotFoundView'
import { NowPlayingView } from './views/NowPlayingView'
import { PlaylistView } from './views/PlaylistView'
import { QueueView } from './views/QueueView'
import { SearchView } from './views/SearchView'
import { StatsView } from './views/StatsView'
import { StatusView } from './views/StatusView'

export default function App() {
  return (
    <ConnectionGate>
    <AppShell>
      {isNative() && <AndroidBack />}
      <Routes>
        <Route path="/" element={<HomeView />} />
        <Route path="/search" element={<SearchView />} />
        <Route path="/library" element={<Navigate to="/library/albums" replace />} />
        <Route path="/library/:tab" element={<LibraryView />} />
        <Route path="/favorites" element={<FavoritesView />} />
        <Route path="/playlists/:playlistId" element={<PlaylistView />} />
        <Route path="/albums/:albumId" element={<AlbumView />} />
        <Route path="/artists" element={<Navigate to="/library/artists" replace />} />
        <Route path="/artists/:artistId" element={<ArtistView />} />
        <Route path="/now-playing" element={<NowPlayingView />} />
        <Route path="/queue" element={<QueueView />} />
        <Route path="/status" element={<StatusView />} />
        <Route path="/stats" element={<StatsView />} />
        <Route path="/settings" element={<SettingsView />} />
        <Route path="/offline" element={<OfflineView />} />
        <Route path="/genres/:genreKey" element={<GenreView />} />
        <Route path="/decades/:decade" element={<DecadeView />} />
        <Route path="/collections/:collectionId" element={<CollectionView />} />
        <Route path="*" element={<NotFoundView />} />
      </Routes>
    </AppShell>
    </ConnectionGate>
  )
}
