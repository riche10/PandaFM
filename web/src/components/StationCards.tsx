import { stationsApi } from '../api/radio'
import { openDialog } from '../dialogs/store'
import { toast } from '../library'
import { startStation } from '../library/play'
import { reloadStations, stationSubtitle, useStations } from '../library/stations'
import { useRadio } from '../player'
import { Icon } from './Icon'
import { MenuButton, MenuItem } from './Menu'

/** My Stations on Home: music neighbourhoods you made (Rock, Metal, Pop Punk…). */
export function StationCards() {
  const { stations } = useStations()
  const active = useRadio()
  const act = async (work: () => Promise<unknown>, message: string) => {
    try {
      await work()
      await reloadStations()
      toast(message)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'That didn’t work.', 'error')
    }
  }
  return (
    <section className="shelf" aria-labelledby="stations-title">
      <div className="shelf-head">
        <h2 id="stations-title" className="section-title">My Stations</h2>
      </div>
      <ul className="shelf-row radio-cards station-cards">
        <li>
          <button type="button" className="radio-card radio-card--new" onClick={() => openDialog({ type: 'station', station: null })}>
            <span className="radio-card-icon" aria-hidden="true"><Icon name="plus" /></span>
            <span>
              <span className="radio-card-name">New station</span>
              <span className="radio-card-sub">Pick the genres it stays in</span>
            </span>
          </button>
        </li>
        {(stations ?? []).map((s) => {
          const on = active?.stationId === s.id
          return (
            <li key={s.id} className="station-card">
              <button type="button" className="radio-card" data-active={on ? '' : undefined} aria-pressed={on} onClick={() => void startStation(s)}>
                <span className="radio-card-icon" aria-hidden="true"><Icon name="radio" /></span>
                {on && <span className="radio-card-live">On air</span>}
                <span>
                  <span className="radio-card-name">{s.name}</span>
                  <span className="radio-card-sub">{stationSubtitle(s)}</span>
                </span>
              </button>
              <MenuButton label={`More for ${s.name}`} className="station-more">
                {(close) => (
                  <>
                    <MenuItem icon="edit" label="Edit station" onSelect={() => { close(); openDialog({ type: 'station', station: s }) }} />
                    <MenuItem icon="copy" label="Duplicate station" onSelect={() => { close(); void act(() => stationsApi.duplicate(s.id), `Duplicated ${s.name}`) }} />
                    <MenuItem icon="trash" label="Delete station" onSelect={() => {
                      close()
                      if (window.confirm(`Delete the ${s.name} station? Your songs, playlists and listening history stay.`)) {
                        void act(() => stationsApi.remove(s.id), `Deleted ${s.name}`)
                      }
                    }} />
                  </>
                )}
              </MenuButton>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
