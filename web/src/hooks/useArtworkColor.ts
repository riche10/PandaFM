import { useEffect, useState } from 'react'
import { coverUrl } from '../api/library'

// The colour behind album, playlist and Now Playing headers comes from the
// artwork itself. Covers are same-origin (/api/covers), so a canvas may read
// their pixels. The result is darkened so white text always stays readable.

const cache = new Map<string, string>()

export function useArtworkColor(coverArtId: string | null): string | null {
  const [color, setColor] = useState<string | null>(() => (coverArtId ? (cache.get(coverArtId) ?? null) : null))

  useEffect(() => {
    if (!coverArtId) {
      setColor(null)
      return
    }
    const cached = cache.get(coverArtId)
    if (cached) {
      setColor(cached)
      return
    }
    let cancelled = false
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      const sampled = sampleColor(image)
      if (!sampled) return
      cache.set(coverArtId, sampled)
      if (!cancelled) setColor(sampled)
    }
    image.src = coverUrl(coverArtId, 96)
    return () => {
      cancelled = true
    }
  }, [coverArtId])

  return color
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
    let r = 0, g = 0, b = 0, total = 0
    for (let i = 0; i < pixels.length; i += 4) {
      const max = Math.max(pixels[i], pixels[i + 1], pixels[i + 2])
      const min = Math.min(pixels[i], pixels[i + 1], pixels[i + 2])
      const weight = 1 + ((max - min) / 255) * 4
      r += pixels[i] * weight
      g += pixels[i + 1] * weight
      b += pixels[i + 2] * weight
      total += weight
    }
    const [h, s, l] = toHsl(r / total, g / total, b / total)
    return `hsl(${Math.round(h)} ${Math.round(Math.min(s, 0.55) * 100)}% ${Math.round(Math.min(Math.max(l, 0.18), 0.32) * 100)}%)`
  } catch {
    return null
  }
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}
