import { type ReactNode, useEffect, useRef } from 'react'

interface ModalProps {
  open: boolean
  onClose: () => void
  label: string
  className?: string
  children: ReactNode
}

/**
 * A native <dialog>: focus is trapped and restored, Esc closes it, and the
 * page behind can't be clicked. Clicking the dimmed backdrop closes it too.
 * Phones show it as a bottom sheet (see .modal in styles.css).
 */
export function Modal({ open, onClose, label, className = '', children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={`modal ${className}`.trim()}
      aria-label={label}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose() // the backdrop, not the content
      }}
    >
      {open && <div className="modal-body">{children}</div>}
    </dialog>
  )
}
