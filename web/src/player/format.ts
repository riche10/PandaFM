/** 0:07, 4:05, 1:02:09. Anything unknown reads as 0:00. */
export function formatTime(totalSeconds: number | null | undefined): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds! > 0 ? Math.floor(totalSeconds!) : 0
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = String(safe % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** Total length for headers: 38 min, 1 hr 12 min. */
export function formatLength(totalSeconds: number | null | undefined): string {
  if (!totalSeconds || totalSeconds <= 0) return ''
  const minutes = Math.max(1, Math.round(totalSeconds / 60))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
}

export const countOf = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
