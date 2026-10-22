import { PageHeader } from '../components/PageHeader'
import { QueueList } from '../components/QueueList'
import { player, usePlayer } from '../player'

/** Phones (and direct links): the queue as its own page. */
export function QueueView() {
  const upcoming = usePlayer((s) => s.items.length - s.index - 1)
  return (
    <div className="page page--queue">
      <PageHeader />
      <div className="section-head">
        <h1 className="page-title">Queue</h1>
        {upcoming > 0 && (
          <button type="button" className="text-button" onClick={() => player.clearQueue('all')}>
            Clear queue
          </button>
        )}
      </div>
      <QueueList />
    </div>
  )
}
