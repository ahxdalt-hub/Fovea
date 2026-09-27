/**
 * Menu — lightweight dropdown for command lists (overflow actions, filters).
 *
 * Closes on outside pointer, Escape, and item activation. Items are real
 * <button>s so keyboard works for free. A future stage swaps in a
 * sub-menu-capable version only if a real need appears.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from './cx'
import './Menu.css'

/** Fade-out duration before the menu unmounts (matches Menu.css). */
const EXIT_MS = 100

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
  checked?: boolean
  /** Renders as destructive (danger text). */
  danger?: boolean
}

export interface MenuProps {
  /** The trigger element; it is rendered with aria-haspopup/expanded. */
  trigger: ReactNode
  items: MenuItem[]
  align?: 'start' | 'end'
  /** Accessible name for the trigger (icon-only triggers have none). */
  label?: string
}

export function Menu({ trigger, items, align = 'end', label }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const exitTimer = useRef<number | null>(null)

  /** Fade out before unmounting; item actions run immediately. */
  const close = useCallback(() => {
    if (exitTimer.current != null) return
    setClosing(true)
    exitTimer.current = window.setTimeout(() => {
      exitTimer.current = null
      setClosing(false)
      setOpen(false)
    }, EXIT_MS)
  }, [])

  /** Trigger activation while the exit is playing cancels it — the user
   * clearly wants the menu, and a half-faded popup must not stick closed. */
  const toggleFromTrigger = useCallback(() => {
    if (exitTimer.current != null) {
      window.clearTimeout(exitTimer.current)
      exitTimer.current = null
      setClosing(false)
      setOpen(true)
      return
    }
    setOpen((v) => !v)
  }, [])

  useEffect(() => {
    return () => {
      if (exitTimer.current != null) window.clearTimeout(exitTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    // Move focus to the first item as the menu opens (desktop convention).
    menuRef.current?.querySelector<HTMLButtonElement>('.pix-menu__item:not(:disabled)')?.focus()
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
        rootRef.current?.querySelector<HTMLElement>('.pix-menu-trigger')?.focus()
        return
      }
      if (
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Home' ||
        event.key === 'End'
      ) {
        const items = Array.from(
          menuRef.current?.querySelectorAll<HTMLButtonElement>('.pix-menu__item:not(:disabled)') ??
            [],
        )
        if (items.length === 0) return
        event.preventDefault()
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        let next: number
        if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = items.length - 1
        else if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length
        else next = current <= 0 ? items.length - 1 : current - 1
        items[next]?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, close])

  return (
    <div className="pix-menu-root" ref={rootRef}>
      <span
        className="pix-menu-trigger"
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleFromTrigger}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            toggleFromTrigger()
          }
        }}
      >
        {trigger}
      </span>
      {open && (
        <div
          ref={menuRef}
          className={cx('pix-menu', `pix-menu--${align}`, closing && 'pix-menu--closing')}
          role="menu"
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={cx('pix-menu__item', item.danger && 'pix-menu__item--danger')}
              disabled={item.disabled}
              onClick={() => {
                if (exitTimer.current != null) return // already closing
                rootRef.current?.querySelector<HTMLElement>('.pix-menu-trigger')?.focus()
                item.onSelect()
                close()
              }}
            >
              {item.icon && <span className="pix-menu__icon">{item.icon}</span>}
              <span className="pix-menu__label">{item.label}</span>
              {item.checked != null && (
                <span className="pix-menu__state">{item.checked ? '✓' : ''}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
