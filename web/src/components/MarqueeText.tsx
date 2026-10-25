import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { marqueeState, sameMarquee } from './marquee'

/**
 * One line of metadata that may be too long (album names, "Next from …").
 * It stays still when it fits. When it doesn't: a pause, a slow glide to the
 * end, a pause, back to the start, repeat. With reduced motion it simply
 * ends in an ellipsis. It never widens its parent.
 */
export function MarqueeText({ children, className = '', title }: { children: ReactNode; className?: string; title?: string }) {
  const outer = useRef<HTMLSpanElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [state, setState] = useState(() => marqueeState(0, 0, false))

  useLayoutEffect(() => {
    const box = outer.current
    const text = inner.current
    if (!box || !text) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const measure = () => {
      const next = marqueeState(box.clientWidth, text.scrollWidth, !!reduce?.matches)
      setState((prev) => (sameMarquee(prev, next) ? prev : next))
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(box)
    observer?.observe(text)
    reduce?.addEventListener?.('change', measure)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      reduce?.removeEventListener?.('change', measure)
      window.removeEventListener('resize', measure)
    }
  }, [children])

  const style = { '--marquee-shift': `-${state.shift}px`, '--marquee-duration': `${state.duration}s` } as CSSProperties
  return (
    <span
      ref={outer}
      className={`marquee ${className}`.trim()}
      data-overflow={state.overflow ? '' : undefined}
      data-animate={state.animate ? '' : undefined}
      title={state.overflow ? title : undefined}
      style={style}
    >
      <span ref={inner} className="marquee-inner">
        {children}
      </span>
    </span>
  )
}
