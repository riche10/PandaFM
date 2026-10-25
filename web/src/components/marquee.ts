// When a single line doesn't fit: how far it has to travel and how long one
// calm back-and-forth takes. Pure, so it can be tested without a browser.

export const MARQUEE_SPEED = 40 // px per second while moving: slow enough to read
export const MARQUEE_MIN_SECONDS = 6
const MOVING = 0.7 // 35% of the cycle each way; 15% resting at each end (see @keyframes pandafm-marquee)

export interface MarqueeState {
  overflow: boolean // the text doesn't fit
  animate: boolean // ...and motion is allowed
  shift: number // px to move left to reveal the end
  duration: number // seconds for one full cycle
}

export function marqueeState(containerWidth: number, contentWidth: number, reducedMotion: boolean): MarqueeState {
  const shift = Math.ceil(contentWidth - containerWidth)
  if (!(containerWidth > 0) || shift <= 1) return { overflow: false, animate: false, shift: 0, duration: 0 }
  const duration = Math.max(MARQUEE_MIN_SECONDS, (2 * shift) / MARQUEE_SPEED / MOVING)
  return { overflow: true, animate: !reducedMotion, shift, duration: Math.round(duration * 10) / 10 }
}

export const sameMarquee = (a: MarqueeState, b: MarqueeState) =>
  a.overflow === b.overflow && a.animate === b.animate && a.shift === b.shift && a.duration === b.duration
