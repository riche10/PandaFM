// Simple geometric icons on a 24×24 grid. Filled unless marked as outlines.
type IconDef = { d: string; outline?: boolean; evenOdd?: boolean }

const ICONS = {
  play: { d: 'M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.9-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z' },
  pause: { d: 'M7 5h3.5v14H7zm6.5 0H17v14h-3.5z' },
  next: { d: 'M6 6.2v11.6a.7.7 0 0 0 1.1.6L15 12.6v5.4h2.5V6H15v5.4L7.1 5.6a.7.7 0 0 0-1.1.6z' },
  previous: { d: 'M18 6.2v11.6a.7.7 0 0 1-1.1.6L9 12.6v5.4H6.5V6H9v5.4l7.9-5.8a.7.7 0 0 1 1.1.6z' },
  search: {
    d: 'M10.5 3.5a7 7 0 0 1 5.6 11.2l4.4 4.4-1.4 1.4-4.4-4.4A7 7 0 1 1 10.5 3.5zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  },
  home: { d: 'M12 3.2 3 10.4V21h6.5v-6.2h5V21H21V10.4z' },
  library: { d: 'M4 4h2.6v16H4zm5 0h2.6v16H9zm5 .9 2.5-.9 5.4 15.1-2.5.9z' },
  heart: {
    d: 'M12 20s-7.5-4.6-9.2-9.3C1.6 7.4 3.6 4 7 4c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.4 0 5.4 3.4 4.2 6.7C19.5 15.4 12 20 12 20z',
  },
  heartOutline: {
    d: 'M12 20s-7.5-4.6-9.2-9.3C1.6 7.4 3.6 4 7 4c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.4 0 5.4 3.4 4.2 6.7C19.5 15.4 12 20 12 20z',
    outline: true,
  },
  plus: { d: 'M11 4.5h2V11h6.5v2H13v6.5h-2V13H4.5v-2H11z' },
  more: {
    d: 'M5 10.3a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4zm7 0a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4zm7 0a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4z',
  },
  close: { d: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z' },
  back: { d: 'M15.4 4.6 8 12l7.4 7.4-1.4 1.4L5.2 12l8.8-8.8z' },
  chevronDown: { d: 'M5 9.4 6.4 8l5.6 5.6L17.6 8 19 9.4l-7 7z' },
  volume: {
    d: 'M3 9.2v5.6h3.8L12 19V5L6.8 9.2zm11.5-2.6v2.1a3.6 3.6 0 0 1 0 6.6v2.1a5.6 5.6 0 0 0 0-10.8z',
  },
  volumeOff: {
    d: 'M3 9.2v5.6h3.8L12 19V5L6.8 9.2zm11.3.2 1.4-1.4 2.3 2.3 2.3-2.3 1.4 1.4-2.3 2.3 2.3 2.3-1.4 1.4-2.3-2.3-2.3 2.3-1.4-1.4 2.3-2.3z',
  },
  playlist: { d: 'M3 5.5h12v2H3zm0 4.5h12v2H3zm0 4.5h7.5v2H3zM17 5.5h4.5v2.2H19V16a3 3 0 1 1-2-2.8z' },
  edit: { d: 'M4 16.9V20h3.1l9.2-9.2-3.1-3.1zM19.8 7.3a1 1 0 0 0 0-1.4l-1.7-1.7a1 1 0 0 0-1.4 0l-1.4 1.4 3.1 3.1z' },
  trash: {
    d: 'M8 4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6h4v2h-1.2l-.9 11.6A2.6 2.6 0 0 1 15.3 22H8.7a2.6 2.6 0 0 1-2.6-2.4L5.2 8H4V6h4zm2 1.5h4V5h-4zM7.2 8l.9 11.4a.6.6 0 0 0 .6.6h6.6a.6.6 0 0 0 .6-.6L16.8 8z',
  },
  expand: { d: 'M4 4h7v2H7.4l4.3 4.3-1.4 1.4L6 7.4V11H4zm16 16h-7v-2h3.6l-4.3-4.3 1.4-1.4 4.3 4.3V13h2z' },
  album: { d: 'M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19zm0 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', evenOdd: true },
  artist: { d: 'M12 12.2a4.3 4.3 0 1 0 0-8.6 4.3 4.3 0 0 0 0 8.6zm0 1.8c-4.3 0-8 2.2-8 5.2V21h16v-1.8c0-3-3.7-5.2-8-5.2z' },
  music: { d: 'M9 4.5 20 2.5v13a3 3 0 1 1-2-2.8V6.9l-7 1.3v9.3a3 3 0 1 1-2-2.8z' },
  shuffle: {
    d: 'M15 4h5v5l-1.8-1.8-11.8 11.8L5 17.6 16.8 5.8zM4 6.4 5.4 5l5 5-1.4 1.4zm11.6 8.6 1.4-1.4 1.2 1.2L20 13v5h-5l1.8-1.8z',
  },
  clock: { d: 'M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19zm-1 4.5v6l5 3 1-1.6-4-2.4V7z', evenOdd: true },
  check: { d: 'M9.6 16.2 4.9 11.5l-1.4 1.4 6.1 6.1L20.5 8.1l-1.4-1.4z' },
} satisfies Record<string, IconDef>

export type IconName = keyof typeof ICONS

export function Icon({ name, className = 'icon' }: { name: IconName; className?: string }) {
  const icon: IconDef = ICONS[name]
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {icon.outline ? (
        <path d={icon.d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      ) : (
        <path d={icon.d} fill="currentColor" fillRule={icon.evenOdd ? 'evenodd' : undefined} />
      )}
    </svg>
  )
}
