import { Icon } from '../components/Icon'
import { QueueList } from '../components/QueueList'
import { closeQueuePanel } from './ui'

/** Desktop: the queue as a panel beside the page, so you can keep browsing. */
export function QueuePanel() {
  return (
    <aside className="queue-panel" aria-label="Queue">
      <header className="queue-panel-head">
        <h2 className="queue-panel-title">Queue</h2>
        <button type="button" className="icon-button icon-button--small" aria-label="Close queue" onClick={closeQueuePanel}>
          <Icon name="close" />
        </button>
      </header>
      <div className="queue-panel-body">
        <QueueList />
      </div>
    </aside>
  )
}
