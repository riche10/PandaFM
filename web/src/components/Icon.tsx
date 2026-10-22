// A handful of simple geometric icons, drawn on a 24×24 grid.
const PATHS = {
  play: 'M8 5v14l11-7z',
  pause: 'M7 5h3.5v14H7zm6.5 0H17v14h-3.5z',
  next: 'M6 6v12l8.5-6zM16 6h2v12h-2z',
  previous: 'M18 6v12l-8.5-6zM6 6h2v12H6z',
  search:
    'M10.5 4a6.5 6.5 0 0 1 5.2 10.4l4.2 4.2-1.4 1.4-4.2-4.2A6.5 6.5 0 1 1 10.5 4zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z',
  close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z',
  back: 'M15.4 4.6 8 12l7.4 7.4-1.4 1.4L5.2 12l8.8-8.8z',
  note: 'M10 4h8v4h-5v9.5A3.5 3.5 0 1 1 10 14.1z',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={PATHS[name]} fill="currentColor" />
    </svg>
  )
}
