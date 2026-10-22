import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { fetchHealth, type Health } from '../api/health'

function describe(health: Health): string | null {
  if (!health.navidrome.ok) return 'PandaFM can’t reach Navidrome, so your library won’t load.'
  if (!health.database.ok) return 'PandaFM’s database isn’t reachable. Browsing and playback still work.'
  return null
}

/** A one-line warning when something PandaFM depends on is down. Silent otherwise. */
export function ConnectionBanner() {
  const [problem, setProblem] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal).then(
      (health) => setProblem(describe(health)),
      () => {
        if (!controller.signal.aborted) setProblem('PandaFM’s API isn’t answering, so your library won’t load.')
      },
    )
    return () => controller.abort()
  }, [attempt])

  if (!problem) return null
  return (
    <div className="banner" role="status">
      <p>{problem}</p>
      <div className="banner-actions">
        <button type="button" className="text-button" onClick={() => setAttempt((n) => n + 1)}>
          Check again
        </button>
        <Link to="/status" className="text-button">
          Details
        </Link>
      </div>
    </div>
  )
}
