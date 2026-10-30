/** 5.5.2: request tickets: only the newest one may apply its response (rapid mode changes, repeated Remix). */
export function createLatest() {
  let n = 0
  return { begin: () => ++n, isLatest: (ticket: number) => ticket === n }
}
