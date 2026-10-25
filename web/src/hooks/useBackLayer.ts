import { useEffect, useRef } from 'react'
import { pushBackLayer } from '../platform/back'

/** While `open`, Android's Back button calls `close` (before any navigation). */
export function useBackLayer(open: boolean, close: () => void): void {
  const latest = useRef(close)
  latest.current = close
  useEffect(() => {
    if (!open) return
    return pushBackLayer(() => latest.current())
  }, [open])
}
