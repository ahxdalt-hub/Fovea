/**
 * Modal dialog with backdrop, Esc-to-close, focus trap, and focus return.
 *
 * Rendered inline (no portal needed: the shell occupies the full window and
 * z-index is managed by tokens). The Settings dialog and later confirmations
 * use this as their only modal implementation.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { IconButton } from './Button'
import { IconClose } from './Icons'
import './Dialog.css'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  /** Optional wide variant for content-heavy dialogs. */
  size?: 'sm' | 'md'
  children: ReactNode
  footer?: ReactNode
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  size = 'sm',
  children,
  footer,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null

    // Initial focus: first focusable inside the panel, else the panel itself.
    const panel = panelRef.current
    if (panel) {
      const first = panel.querySelector<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      )
      ;(first ?? panel).focus()
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key === 'Tab' && panel) {
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute('disabled'))
        if (focusables.length === 0) return
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="pix-dialog__backdrop anim-fade" onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('pix-dialog', `pix-dialog--${size}`)}
        onMouseDown={(event) => event.stopPropagation()}
        tabIndex={-1}
      >
        <header className="pix-dialog__header">
          <div>
            <h2 className="pix-dialog__title">{title}</h2>
            {description && <p className="pix-dialog__description">{description}</p>}
          </div>
          <IconButton label="Close dialog" size="sm" onClick={onClose}>
            <IconClose size="sm" />
          </IconButton>
        </header>
        <div className="pix-dialog__body">{children}</div>
        {footer && <footer className="pix-dialog__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
