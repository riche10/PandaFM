import type { ReactNode } from 'react'
import type { ApiError } from '../api/client'
import { Icon, type IconName } from './Icon'

export function Loading({ label }: { label: string }) {
  return (
    <p className="hint loading" aria-busy="true">
      {label}
    </p>
  )
}

export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">
        <Icon name={icon} />
      </span>
      <h2 className="empty-state-title">{title}</h2>
      {children && <div className="empty-state-body">{children}</div>}
    </div>
  )
}

export function ErrorNotice({ error, onRetry }: { error: ApiError | string; onRetry?: () => void }) {
  return (
    <div className="notice" role="alert">
      <p>{typeof error === 'string' ? error : error.message}</p>
      {onRetry && (
        <button type="button" className="button button--quiet" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}
