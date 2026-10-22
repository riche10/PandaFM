import { type ReactNode, useEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { ConnectionBanner } from '../components/ConnectionBanner'
import { Toaster } from '../components/Toaster'
import { DialogHost } from '../dialogs/DialogHost'
import { useIsDesktop } from '../hooks/useMediaQuery'
import { player, useCurrentTrack } from '../player'
import { BottomNav } from './BottomNav'
import { MiniPlayer } from './MiniPlayer'
import { PlayerBar } from './PlayerBar'
import { QueuePanel } from './QueuePanel'
import { Sidebar } from './Sidebar'
import { useQueueOpen } from './ui'

/**
 * The frame around every page. The player lives in a store outside React,
 * so moving between pages never interrupts playback; this shell only shows
 * its controls: a full player bar on desktop, a mini player on phones.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const isDesktop = useIsDesktop()
  const queueOpen = useQueueOpen()
  const track = useCurrentTrack()
  const main = useMainScroll()

  usePlayPauseShortcut()
  useEffect(() => {
    document.title = track ? `${track.title} · ${track.artist} | PandaFM` : 'PandaFM'
  }, [track])

  return (
    <div
      className="shell"
      data-layout={isDesktop ? 'desktop' : 'mobile'}
      data-has-track={track ? '' : undefined}
      data-queue={isDesktop && queueOpen ? '' : undefined}
    >
      {isDesktop && <Sidebar />}
      <main className="shell-main" ref={main} id="main">
        <ConnectionBanner />
        {children}
      </main>
      {isDesktop && queueOpen && <QueuePanel />}
      {isDesktop ? (
        <PlayerBar />
      ) : (
        <div className="shell-bottom">
          <MiniPlayer />
          <BottomNav />
        </div>
      )}
      <Toaster />
      <DialogHost />
    </div>
  )
}

/**
 * Pages scroll inside <main>, not the window, so the browser can't restore
 * positions itself. New pages start at the top; Back returns to where you were.
 */
function useMainScroll() {
  const ref = useRef<HTMLElement>(null)
  const location = useLocation()
  const navigationType = useNavigationType()
  const positions = useRef(new Map<string, number>())

  useEffect(() => {
    const main = ref.current
    if (!main) return
    const key = location.key
    const target = navigationType === 'POP' ? (positions.current.get(key) ?? 0) : 0
    main.scrollTop = target
    // Content loads after navigation, so keep trying briefly until it's tall enough.
    let frame = 0
    const deadline = performance.now() + 1500
    const restore = () => {
      if (Math.abs(main.scrollTop - target) < 2 || performance.now() > deadline) return
      main.scrollTop = target
      frame = requestAnimationFrame(restore)
    }
    if (target > 0) frame = requestAnimationFrame(restore)
    const remember = () => positions.current.set(key, main.scrollTop)
    main.addEventListener('scroll', remember, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      main.removeEventListener('scroll', remember)
    }
  }, [location.key, location.pathname, navigationType])

  return ref
}

/** Space plays/pauses, unless you're typing or on a control that uses Space itself. */
function usePlayPauseShortcut() {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, button, a, [contenteditable], dialog')) return
      event.preventDefault()
      player.togglePlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
