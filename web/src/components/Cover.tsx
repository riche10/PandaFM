import { useState } from 'react'
import type { CoverSize } from '../api/library'
import { artworkSrc } from '../offline'
import { Icon } from './Icon'

interface CoverProps {
  coverArtId: string | null
  size: CoverSize
  className?: string
}

/** Artwork through PandaFM's cover proxy, with a quiet placeholder when there is none. */
export function Cover({ coverArtId, size, className = '' }: CoverProps) {
  const [failedId, setFailedId] = useState<string | null>(null)
  const classes = `cover ${className}`.trim()

  if (!coverArtId || failedId === coverArtId) {
    return (
      <span className={`${classes} cover--empty`} aria-hidden="true">
        <Icon name="music" />
      </span>
    )
  }
  return (
    <img
      className={classes}
      src={artworkSrc(coverArtId, size)}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailedId(coverArtId)}
    />
  )
}
