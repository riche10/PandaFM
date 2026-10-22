/** Three bars marking the song that's playing (still when paused or reduced motion). */
export function Equalizer({ playing }: { playing: boolean }) {
  return (
    <span className="equalizer" data-playing={playing ? '' : undefined} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}
