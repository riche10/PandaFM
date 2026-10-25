import type { AudioQuality } from '../api/library'

/**
 * One honest quality line for a set of songs (an album), or null.
 * Exact only when every song shares it ("FLAC · HI-RES · 24-bit / 96 kHz");
 * "Lossless · mixed formats" when all are lossless but differ; otherwise
 * "Mixed quality". Unknown songs: say nothing rather than guess.
 */
export function albumQuality(qualities: (AudioQuality | null | undefined)[]): string | null {
  if (qualities.length === 0 || qualities.some((q) => !q)) return null
  const qs = qualities as AudioQuality[]
  const same = (f: (q: AudioQuality) => unknown) => new Set(qs.map(f)).size === 1
  if (same((q) => q.codec) && same((q) => q.detail) && same((q) => q.badge) && same((q) => q.lossless)) {
    const q = qs[0]
    return [q.codec, q.badge, q.detail].filter(Boolean).join(' · ')
  }
  if (qs.every((q) => q.lossless === true)) return qs.every((q) => q.hi_res) ? 'Hi-Res · mixed formats' : 'Lossless · mixed formats'
  return 'Mixed quality'
}
