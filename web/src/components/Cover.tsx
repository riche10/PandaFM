import { useState } from 'react'
import type { CoverSize } from '../api/library'
import { useCoverSrc } from '../hooks/useCoverSrc'
import { Icon } from './Icon'

interface CoverProps {
  coverArtId: string | null
  size: CoverSize
  className?: string
}

/** Artwork through PandaFM's cover proxy, with a quiet placeholder when there is none. */
export function Cover({ coverArtId, size, className = '' }: CoverProps) {
  const [failedId, setFailedId] = useState<string | null>(null)
  const src = useCoverSrc(coverArtId, size)
  const classes = `cover ${className}`.trim()

  if (!coverArtId || !src || failedId === coverArtId) {
    return (
      <span className={`${classes} cover--empty`} aria-hidden="true">
        <Icon name="music" />
      </span>
    )
  }
  return (
    <img
      className={classes}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailedId(coverArtId)}
    />
  )
}
