import { useState } from 'react'
import { getStats, getSyncStatus, startSync } from '../api/radio'
import { PageHeader } from '../components/PageHeader'
import { ErrorNotice, Loading } from '../components/States'
import { useApi } from '../hooks/useApi'

const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`)

/** A plain, developer-facing look at what PandaFM is learning. */
export function StatsView() {
  const [attempt, setAttempt] = useState(0)
  const [stats, retry] = useApi(`stats:${attempt}`, (signal) => getStats(signal))
  const [sync] = useApi(`sync:${attempt}`, (signal) => getSyncStatus(signal))

  const resync = async () => {
    await startSync()
    setTimeout(() => setAttempt((n) => n + 1), 1500)
  }

  return (
    <div className="page page--stats">
      <PageHeader />
      <h1 className="page-title">Listening statistics</h1>
      <p className="hint">What PandaFM has learned so far. Mostly for checking that it learns sensible things.</p>

      {sync.state === 'ready' && (
        <section className="stats-block">
          <h2 className="section-title">Library cache</h2>
          <p>
            {sync.data.tracks_available} songs available ({sync.data.tracks_total} known).{' '}
            {sync.data.last_run && (
              <>
                Last sync: {sync.data.last_run.status}, {new Date(sync.data.last_run.started_at).toLocaleString()}
                {sync.data.last_run.error ? ` (${sync.data.last_run.error})` : ''}.
              </>
            )}
          </p>
          <button type="button" className="button button--quiet" onClick={() => void resync()} disabled={sync.data.running}>
            {sync.data.running ? 'Syncing…' : 'Sync with Navidrome now'}
          </button>
        </section>
      )}

      {stats.state === 'error' ? (
        <ErrorNotice error={stats.error} onRetry={retry} />
      ) : stats.state === 'loading' ? (
        <Loading label="Loading statistics…" />
      ) : (
        <>
          <dl className="stats-grid">
            <div><dt>Events recorded</dt><dd>{stats.data.events}</dd></div>
            <div><dt>Plays</dt><dd>{stats.data.plays}</dd></div>
            <div><dt>Completion rate</dt><dd>{pct(stats.data.completion_rate)}</dd></div>
            <div><dt>Early skip rate</dt><dd>{pct(stats.data.early_skip_rate)}</dd></div>
            <div><dt>Radio sessions</dt><dd>{stats.data.radio_sessions}</dd></div>
          </dl>
          <StatsTable title="Artists you finish" rows={stats.data.top_completed_artists.map((r) => [r.name, `${r.completed} finished`, `${r.plays} plays`])} />
          <StatsTable title="Artists you skip" rows={stats.data.most_skipped_artists.map((r) => [r.name, `${r.early} early skips`, `${r.skips} skips`])} />
          <StatsTable title="Genres by listening time" rows={stats.data.top_genres.map((r) => [r.name, `${r.minutes} min`, `${r.completed} finished`])} />
          <StatsTable
            title="Recent radio sessions"
            rows={stats.data.recent_sessions.map((r) => [`${r.mode}${r.seed ? ` · ${r.seed}` : ''}`, `${r.played} played, ${r.skipped} skipped`, `${r.replaced} re-planned`])}
          />
        </>
      )}
    </div>
  )
}

function StatsTable({ title, rows }: { title: string; rows: string[][] }) {
  return (
    <section className="stats-block">
      <h2 className="section-title">{title}</h2>
      {rows.length === 0 ? (
        <p className="hint">Nothing yet.</p>
      ) : (
        <table className="stats-table">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
