import { Cover } from './Cover'
import { Icon } from './Icon'

/** A genre's artwork: a small collage of album covers from your library, or a quiet tag icon. */
export function GenreArt({ covers, className = '' }: { covers: string[]; className?: string }) {
  if (covers.length === 0) {
    return (
      <span className={`genre-art genre-art--empty ${className}`.trim()} aria-hidden="true">
        <Icon name="tag" />
      </span>
    )
  }
  const four = covers.length >= 4 ? covers.slice(0, 4) : [covers[0]]
  return (
    <span className={`genre-art ${four.length === 4 ? 'genre-art--grid' : ''} ${className}`.trim()} aria-hidden="true">
      {four.map((c, i) => <Cover key={`${c}-${i}`} coverArtId={c} size={four.length === 4 ? 96 : 300} />)}
    </span>
  )
}
