import { dismissToast, useToasts } from '../library/toasts'

export function Toaster() {
  const toasts = useToasts()
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className="toast" data-tone={t.tone} onClick={() => dismissToast(t.id)}>
          {t.message}
        </button>
      ))}
    </div>
  )
}
