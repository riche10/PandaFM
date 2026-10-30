import type { FavoriteKind } from '../api/library'
import { toggleFavorite, useFavorite } from '../library'
import { Icon } from './Icon'

interface FavoriteButtonProps {
  kind: FavoriteKind
  id: string
  fromServer: boolean
  label: string // e.g. the song title, for screen readers
  className?: string
}

export function FavoriteButton({ kind, id, fromServer, label, className = '' }: FavoriteButtonProps) {
  const favorite = useFavorite(kind, id, fromServer)
  return (
    <button
      type="button"
      className={`icon-button favorite-button ${className}`.trim()}
      aria-pressed={favorite}
      aria-label={favorite ? `Remove ${label} from Favorites` : `Add ${label} to Favorites`}
      onClick={() => void toggleFavorite(kind, id, favorite)}
    >
      <Icon name={favorite ? 'paw' : 'pawOutline'} />
    </button>
  )
}
