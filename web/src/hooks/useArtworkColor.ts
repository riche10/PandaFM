import { type CSSProperties, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { coverUrl } from '../api/library'
import { appearanceVersion, currentAppearance, subscribeAppearance } from '../appearance/apply'
import { artworkTint, ensureContrast, mix, readableOn, toHex } from '../appearance/color'
import { platform } from '../platform/state'

// Album artwork is PandaFM's main source of colour. The cover's dominant
// colour is sampled once, then made safe for the current theme: darkened on
// dark themes, lightened on light ones, always readable with the theme's text.
// Artwork colours can be Off, Subtle (headers, Now Playing, the player) or
// Immersive (more of the music screens, plus the artwork's own accent).

const raw = new Map<string, string>()
const accents = new Map<string, { accent: string; contrast: string }>()

export function useArtworkColor(coverArtId: string | null): string | null {
  const [sampled, setSampled] = useState<string | null>(() => (coverArtId ? (raw.get(coverArtId) ?? null) : null))
  const version = useSyncExternalStore(subscribeAppearance, appearanceVersion, appearanceVersion)

  useEffect(() => {
    if (!coverArtId) return setSampled(null)
    const cached = raw.get(coverArtId)
    if (cached) return setSampled(cached)
    let cancelled = false
    const image = new Image()
    image.decoding = 'async'
    if (platform.server) image.crossOrigin = 'anonymous' // the app loads covers from the server's origin
    image.onload = () => {
      const color = sampleColor(image)
      if (!color) return
      raw.set(coverArtId, color)
      if (!cancelled) setSampled(color)
    }
    image.src = coverUrl(coverArtId, 96)
    return () => {
      cancelled = true
    }
  }, [coverArtId])

  return useMemo(() => {
    const a = currentAppearance()
    if (!sampled || !a || a.artwork === 'off') return null
    const tint = artworkTint(sampled, a.scheme, a.tokens['text-primary'])
    const accent = ensureContrast(mix(sampled, a.scheme === 'dark' ? '#ffffff' : '#000000', 0.1), tint, 3)
    accents.set(tint, { accent, contrast: readableOn(accent) })
    return tint
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampled, version])
}

/** Style variables for a music screen tinted by its artwork. */
export function artVars(tint: string | null): CSSProperties | undefined {
  if (!tint) return undefined
  const vars: Record<string, string> = { '--art': tint }
  const extra = accents.get(tint)
  if (extra && currentAppearance()?.artwork === 'immersive') {
    Object.assign(vars, { '--art-reach': '100%', '--accent': extra.accent, '--ink': extra.accent, '--accent-contrast': extra.contrast })
  }
  return vars as CSSProperties
}

function sampleColor(image: HTMLImageElement): string | null {
  try {
    const size = 16
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return null
    context.drawImage(image, 0, 0, size, size)
    const pixels = context.getImageData(0, 0, size, size).data
    // Weight colourful pixels more, so a grey border doesn't win.
    let r = 0
    let g = 0
    let b = 0
    let total = 0
    for (let i = 0; i < pixels.length; i += 4) {
      const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2])
      const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2])
      const weight = 1 + ((max - min) / 255) * 4
      r += pixels[i] * weight
      g += pixels[i + 1] * weight
      b += pixels[i + 2] * weight
      total += weight
    }
    return total ? toHex([r / total, g / total, b / total]) : null
  } catch {
    return null // unreadable (e.g. cross-origin without CORS): no tint
  }
}
