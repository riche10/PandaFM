import { Link } from 'react-router'
import { PageHeader } from '../components/PageHeader'

export function NotFoundView() {
  return (
    <main className="page">
      <PageHeader />
      <div className="empty">
        <p>There’s no page at this address.</p>
        <Link to="/" className="button">
          Go to your library
        </Link>
      </div>
    </main>
  )
}
