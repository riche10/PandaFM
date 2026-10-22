import type { ApiError } from '../api/client'

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
