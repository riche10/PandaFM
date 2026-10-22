import { NavLink } from 'react-router'
import { Icon, type IconName } from '../components/Icon'

const ITEMS: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/search', label: 'Search', icon: 'search' },
  { to: '/library', label: 'Library', icon: 'library' },
]

export function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Main">
      {ITEMS.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} className="bottom-nav-link">
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
