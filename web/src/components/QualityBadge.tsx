import { useEffect, useState } from 'react'
import { apiGet } from '../api/client'
import type { AudioQuality, Track } from '../api/library'

const fetched = new Map<string, AudioQuality | null>()

/**
 * Compact audio facts: "FLAC · HI-RES · 24-bit / 96 kHz", "MP3 · 320 kbps".
 * The server decides what counts as lossless and Hi-Res (one rule, in the API);
 * this only displays it. Tracks without facts are looked up once.
 */
export function QualityBadge({ track, variant = 'line' }: { track: Track; variant?: 'line' | 'chip' }) {
  const [quality, setQuality] = useState<AudioQuality | null>(track.quality ?? fetched.get(track.id) ?? null)

  useEffect(() => {
    if (track.quality) return setQuality(track.quality)
    if (fetched.has(track.id)) return setQuality(fetched.get(track.id) ?? null)
    let live = true
    apiGet<{ quality: AudioQuality | null }>(`/tracks/${encodeURIComponent(track.id)}/audio-info`)
      .then((info) => {
        fetched.set(track.id, info.quality)
        if (live) setQuality(info.quality)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [track.id, track.quality])

  if (!quality) return null
  if (variant === 'chip') {
    return <span className={`quality-chip${quality.badge ? ' quality-chip--lossless' : ''}`}>{quality.badge ?? quality.codec}</span>
  }
  const parts = [quality.codec, quality.badge, quality.detail, !quality.lossless && quality.bitrate_kbps ? `${quality.bitrate_kbps} kbps` : null].filter(Boolean)
  return (
    <span className="quality-line" aria-label={`Audio: ${parts.join(', ')}`}>
      {parts.map((part, i) => (
        <span key={i} className={part === 'HI-RES' || part === 'LOSSLESS' ? 'quality-badge' : undefined}>
          {part}
        </span>
      ))}
    </span>
  )
}

export const formatBytes = (bytes: number | null | undefined): string => {
  if (!bytes) return '0 MB'
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}
