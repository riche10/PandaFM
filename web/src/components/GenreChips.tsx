import { useState } from 'react'
import { Link } from 'react-router'
import type { GenreTag } from '../api/library'

/** Genre chips that link to their genre page; wrap on small screens, never overflow. */
export function GenreChips({ tags, limit = 6, label = 'Genres' }: { tags: GenreTag[] | undefined; limit?: number; label?: string }) {
  const [all, setAll] = useState(false)
  if (!tags || tags.length === 0) return null
  const shown = all ? tags : tags.slice(0, limit)
  return (
    <ul className="genre-chips" aria-label={label}>
      {shown.map((t) => (
        <li key={t.key}>
          <Link className="genre-chip" to={`/genres/${encodeURIComponent(t.key)}`}>{t.name}</Link>
        </li>
      ))}
      {tags.length > shown.length && (
        <li>
          <button type="button" className="genre-chip genre-chip--more" onClick={() => setAll(true)}>+{tags.length - shown.length}</button>
        </li>
      )}
    </ul>
  )
}
