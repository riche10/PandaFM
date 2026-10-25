import { useBackLayer } from '../hooks/useBackLayer'
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './Icon'

/**
 * A "⋯" button that opens a menu. Desktop: a small panel beside the button.
 * Phone: a bottom sheet (CSS). Built on a modal <dialog>, so Esc, focus
 * return and click-outside all behave; only mounted while open.
 */
export function MenuButton({
  label,
  className = '',
  header,
  children,
}: {
  label: string
  className?: string
  header?: ReactNode
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`icon-button ${className}`.trim()}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon name="more" />
      </button>
      {open && (
        <MenuDialog anchor={button} onClosed={() => setOpen(false)} header={header} label={label}>
          {children}
        </MenuDialog>
      )}
    </>
  )
}

function MenuDialog({
  anchor,
  onClosed,
  header,
  label,
  children,
}: {
  anchor: RefObject<HTMLButtonElement | null>
  onClosed: () => void
  header?: ReactNode
  label: string
  children: (close: () => void) => ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = () => ref.current?.close()
  useBackLayer(true, close) // mounted only while open; Android Back closes it first

  useLayoutEffect(() => {
    const dialog = ref.current
    const button = anchor.current
    if (!dialog || !button) return
    dialog.showModal()
    if (!window.matchMedia('(min-width: 900px)').matches) return // bottom sheet
    const rect = button.getBoundingClientRect()
    const width = dialog.offsetWidth
    const height = dialog.offsetHeight
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
    const below = rect.bottom + 4
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below
    dialog.style.left = `${left}px`
    dialog.style.top = `${top}px`
  }, [anchor])

  return (
    <dialog
      ref={ref}
      className="menu"
      aria-label={label}
      onClose={onClosed}
      onClick={(event) => {
        if (event.target === ref.current) close()
      }}
    >
      <div className="menu-body">
        {header}
        <div role="menu">{children(close)}</div>
      </div>
    </dialog>
  )
}

export function MenuItem({ icon, label, onSelect }: { icon: Parameters<typeof Icon>[0]['name']; label: string; onSelect: () => void }) {
  return (
    <button type="button" role="menuitem" className="menu-item" onClick={onSelect}>
      <Icon name={icon} />
      <span>{label}</span>
    </button>
  )
}
