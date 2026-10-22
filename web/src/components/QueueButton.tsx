import { useLocation, useNavigate } from 'react-router'
import { useIsDesktop } from '../hooks/useMediaQuery'
import { toggleQueuePanel, useQueueOpen } from '../shell/ui'
import { Icon } from './Icon'

/** Desktop: opens the queue panel beside the page. Phones: goes to the Queue page. */
export function QueueButton({ className = '' }: { className?: string }) {
  const isDesktop = useIsDesktop()
  const open = useQueueOpen()
  const navigate = useNavigate()
  const location = useLocation()
  const onQueuePage = location.pathname === '/queue'
  const pressed = isDesktop ? open : onQueuePage

  return (
    <button
      type="button"
      className={`icon-button toggle-button ${className}`.trim()}
      aria-label="Queue"
      aria-pressed={pressed}
      onClick={() => (isDesktop ? toggleQueuePanel() : onQueuePage ? navigate(-1) : navigate('/queue'))}
    >
      <Icon name="queue" />
    </button>
  )
}
