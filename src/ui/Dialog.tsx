/**
 * Modal dialog with backdrop, Esc-to-close, focus trap, and focus return.
 *
 * Rendered inline (no portal needed: the shell occupies the full window and
 * z-index is managed by tokens). The Settings dialog and later confirmations
 * use this as their only modal implementation.
 *
 * Motion: entries rise on the shared dialog-in keyframe; closing plays a
 * shorter fade/settle *before* unmounting, so a dismissed dialog leaves the
 * way it arrived instead of vanishing mid-frame. Programmatic closes from a
 * parent (e.g. an export finishing) skip the exit — the work is done and the
 * dialog simply gets out of the way.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cx } from './cx'
import { IconButton } from './Button'
import { IconClose } from './Icons'
import './Dialog.css'

/** How long the exit animation runs before the dialog unmounts. */
const EXIT_MS = 140

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  /** Optional wide variant for content-heavy dialogs. */
  size?: 'sm' | 'md' | 'lg'
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
  const closingRef = useRef(false)
  const exitTimer = useRef<number | null>(null)
  const [closing, setClosing] = useState(false)

  // Reopening resets any mid-exit visual state — derived from the open
  // transition during render (no setState-in-effect).
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setClosing(false)
  }

  // The owner's onClose may be a fresh closure on every render; the exit
  // path must stay stable so it never re-triggers focus work mid-dialog.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // One animated path out for Esc, backdrop and the close button. The
  // pending-timer check doubles as the re-entry guard.
  const requestClose = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null
      onCloseRef.current()
    }, EXIT_MS)
  }, [])

  useEffect(() => {
    if (!open) {
      if (exitTimer.current != null) {
        window.clearTimeout(exitTimer.current)
        exitTimer.current = null
      }
      closingRef.current = false
      return
    }
    // A stale exit timer from a previous close must not dismiss this visit.
    if (exitTimer.current != null) {
      window.clearTimeout(exitTimer.current)
      exitTimer.current = null
    }
    closingRef.current = false
    // Initial focus lands on the panel itself, not the first button: the
    // header's close affordance must never be one accidental Enter away.
    restoreRef.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus()

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        requestClose()
        return
      }
      const panel = panelRef.current
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
  }, [open, requestClose])

  useEffect(() => {
    return () => {
      if (exitTimer.current != null) window.clearTimeout(exitTimer.current)
    }
  }, [])

  if (!open) return null

  return createPortal(
    <div
      className={cx(
        'pix-dialog__backdrop',
        'anim-fade',
        closing && 'pix-dialog__backdrop--closing',
      )}
      onMouseDown={requestClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cx('pix-dialog', `pix-dialog--${size}`, closing && 'pix-dialog--closing')}
        onMouseDown={(event) => event.stopPropagation()}
        tabIndex={-1}
      >
        <header className="pix-dialog__header">
          <div>
            <h2 className="pix-dialog__title">{title}</h2>
            {description && <p className="pix-dialog__description">{description}</p>}
          </div>
          <IconButton label="Close dialog" size="sm" onClick={requestClose}>
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
