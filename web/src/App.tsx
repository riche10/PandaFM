import { useEffect } from 'react'
import { Route, Routes, useLocation, useNavigationType } from 'react-router'
import { ConnectionBanner } from './components/ConnectionBanner'
import { MiniPlayer } from './components/MiniPlayer'
import { usePlayer } from './player'
import { AlbumView } from './views/AlbumView'
import { ArtistsView } from './views/ArtistsView'
import { ArtistView } from './views/ArtistView'
import { HomeView } from './views/HomeView'
import { NotFoundView } from './views/NotFoundView'
import { NowPlayingView } from './views/NowPlayingView'
import { StatusView } from './views/StatusView'

export default function App() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const hasTrack = usePlayer((s) => s.index >= 0)
  const showMiniPlayer = hasTrack && location.pathname !== '/now-playing'

  // New pages start at the top; going back keeps the browser's scroll position.
  useEffect(() => {
    if (navigationType !== 'POP') window.scrollTo(0, 0)
  }, [location.pathname, navigationType])

  return (
    <div className="app" data-mini-player={showMiniPlayer ? '' : undefined}>
      <ConnectionBanner />
      <Routes>
        <Route path="/" element={<HomeView />} />
        <Route path="/albums/:albumId" element={<AlbumView />} />
        <Route path="/artists" element={<ArtistsView />} />
        <Route path="/artists/:artistId" element={<ArtistView />} />
        <Route path="/now-playing" element={<NowPlayingView />} />
        <Route path="/status" element={<StatusView />} />
        <Route path="*" element={<NotFoundView />} />
      </Routes>
      {showMiniPlayer && <MiniPlayer />}
    </div>
  )
}
