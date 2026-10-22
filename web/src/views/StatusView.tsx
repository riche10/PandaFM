import { useCallback, useEffect, useState } from 'react'
import { fetchHealth, type Health } from '../api/health'
import { PageHeader } from '../components/PageHeader'
import { Wordmark } from '../components/Wordmark'

// The Stage 1 connection check, kept at /status. It shows the whole chain:
// phone → web container → API → database + Navidrome. The connection banner
// links here when something is down.

type Check =
  | { state: 'checking' }
  | { state: 'answered'; health: Health }
  | { state: 'unreachable'; message: string }

type RowStatus = 'ok' | 'problem' | 'waiting'

interface Row {
  name: string
  status: RowStatus
  note?: string | null
}

const STATUS_LABEL: Record<RowStatus, string> = {
  ok: 'Connected',
  problem: 'Not connected',
  waiting: 'Checking…',
}

function rowsFor(check: Check): Row[] {
  if (check.state === 'checking') {
    return [
      { name: 'Web app', status: 'ok' },
      { name: 'PandaFM API', status: 'waiting' },
      { name: 'Database', status: 'waiting' },
      { name: 'Navidrome', status: 'waiting' },
    ]
  }

  if (check.state === 'unreachable') {
    const unknown = 'Unknown until the API answers.'
    return [
      { name: 'Web app', status: 'ok' },
      {
        name: 'PandaFM API',
        status: 'problem',
        note: `${check.message} On the server, run: docker compose logs pandafm-api`,
      },
      { name: 'Database', status: 'waiting', note: unknown },
      { name: 'Navidrome', status: 'waiting', note: unknown },
    ]
  }

  const { database, navidrome, version } = check.health
  return [
    { name: 'Web app', status: 'ok' },
    { name: 'PandaFM API', status: 'ok', note: `Version ${version}` },
    {
      name: 'Database',
      status: database.ok ? 'ok' : 'problem',
      note: database.ok ? `PostgreSQL ${database.server_version ?? ''}`.trim() : database.detail,
    },
    {
      name: 'Navidrome',
      status: navidrome.ok ? 'ok' : 'problem',
      note: navidrome.ok ? `Navidrome ${navidrome.server_version ?? ''}`.trim() : navidrome.detail,
    },
  ]
}

function summaryFor(check: Check, rows: Row[]): string {
  if (check.state === 'checking') return 'Checking connections…'
  if (rows.every((row) => row.status === 'ok')) return 'Everything is connected.'
  return 'Something isn’t connected yet. The details below say what to fix.'
}

export function StatusView() {
  const [check, setCheck] = useState<Check>({ state: 'checking' })

  const runCheck = useCallback(async (signal?: AbortSignal) => {
    setCheck({ state: 'checking' })
    try {
      const health = await fetchHealth(signal)
      setCheck({ state: 'answered', health })
    } catch (err) {
      if (signal?.aborted) return
      setCheck({ state: 'unreachable', message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void runCheck(controller.signal)
    return () => controller.abort()
  }, [runCheck])

  const rows = rowsFor(check)
  const navidromeUrl = `http://${window.location.hostname}:4533`

  return (
    <main className="page">
      <PageHeader />
      <header>
        <Wordmark size="large" />
        <p className="tagline">Radio from your own music library.</p>
      </header>

      <section className="check" aria-labelledby="check-title">
        <h2 id="check-title">Connection check</h2>
        <p className="check-summary" aria-live="polite">
          {summaryFor(check, rows)}
        </p>

        <ul className="check-list">
          {rows.map((row) => (
            <li key={row.name} className="check-row" data-status={row.status}>
              <span className="check-name">{row.name}</span>
              <span className="check-state">
                <span className="dot" aria-hidden="true" />
                {row.status === 'waiting' && check.state !== 'checking' ? 'Unknown' : STATUS_LABEL[row.status]}
              </span>
              {row.note && <span className="check-note">{row.note}</span>}
            </li>
          ))}
        </ul>

        <button
          type="button"
          className="button"
          onClick={() => void runCheck()}
          disabled={check.state === 'checking'}
        >
          Check again
        </button>
      </section>

      <p className="footnote">
        <a href="/stats">Listening statistics and library sync</a>
      </p>
      <footer className="footnote">
        Navidrome’s own admin pages are at <a href={navidromeUrl}>{navidromeUrl}</a> (unless
        you changed NAVIDROME_PORT).
      </footer>
    </main>
  )
}
