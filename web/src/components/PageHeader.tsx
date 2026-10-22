import { useLocation, useNavigate } from 'react-router'
import { Icon } from './Icon'

/** Back button that behaves like Android's: back in history, or home if opened directly. */
export function PageHeader({ title }: { title?: string }) {
  const navigate = useNavigate()
  const location = useLocation()
  const goBack = () => (location.key === 'default' ? navigate('/') : navigate(-1))

  return (
    <header className="page-header">
      <button type="button" className="icon-button" onClick={goBack} aria-label="Back">
        <Icon name="back" />
      </button>
      {title && <span className="page-header-title">{title}</span>}
    </header>
  )
}
