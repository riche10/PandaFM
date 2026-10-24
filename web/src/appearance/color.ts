// Small colour maths for themes and artwork: parsing, WCAG contrast, mixing,
// and nudging a colour until text on it (or it on a background) is readable.

export type RGB = [number, number, number]

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export const isHex = (value: unknown): value is string => typeof value === 'string' && HEX.test(value)

export function parseHex(hex: string): RGB {
  const h = hex.length === 4 ? hex.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3') : hex
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

export const toHex = ([r, g, b]: RGB) => `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Mix two colours; amount = share of `b` (0..1). */
export function mix(a: string, b: string, amount: number): string {
  const [x, y] = [parseHex(a), parseHex(b)]
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * amount) as RGB)
}

/** Move `color` towards black or white (whichever helps) until it reaches `min` contrast against `against`. */
export function ensureContrast(color: string, against: string, min: number): string {
  if (contrast(color, against) >= min) return color
  const target = luminance(against) > 0.18 ? '#000000' : '#ffffff'
  for (let step = 1; step <= 20; step++) {
    const candidate = mix(color, target, step / 20)
    if (contrast(candidate, against) >= min) return candidate
  }
  return target
}

/** A readable foreground for text or icons on `background`. */
export const readableOn = (background: string, dark = '#141210', light = '#fbf8f3') =>
  contrast(dark, background) >= contrast(light, background) ? dark : light

/**
 * An artwork colour made safe for the theme: on dark themes it is darkened
 * until the theme's light text is clearly readable on it; on light themes it
 * is lightened until dark text is. Text never sits on an unreadable tint.
 */
export function artworkTint(raw: string, scheme: 'light' | 'dark', text: string, min = 4.5): string {
  return ensureContrast(scheme === 'dark' ? mix(raw, '#000000', 0.15) : mix(raw, '#ffffff', 0.45), text, min)
}
