import type { ReactNode } from 'react'
import { artVars } from '../hooks/useArtworkColor'
import { PageHeader } from './PageHeader'

/** The top of album, artist, playlist and Favorites pages, washed in the artwork's colour. */
export function DetailHero({
  art,
  kind,
  title,
  meta,
  actions,
  color,
  round,
}: {
  art: ReactNode
  kind: string
  title: string
  meta: ReactNode
  actions: ReactNode
  color: string | null
  round?: boolean
}) {
  return (
    <header className="hero" style={artVars(color)}>
      <PageHeader />
      <div className="hero-main">
        <div className="hero-art" data-round={round ? '' : undefined}>
          {art}
        </div>
        <div className="hero-text">
          <span className="hero-kind">{kind}</span>
          <h1 className="hero-title" data-long={title.length > 28 ? '' : undefined}>
            {title}
          </h1>
          <div className="hero-meta">{meta}</div>
        </div>
      </div>
      <div className="hero-actions">{actions}</div>
    </header>
  )
}
