/**
 * Menu — lightweight dropdown for command lists (overflow actions, filters).
 *
 * Closes on outside pointer, Escape, and item activation. Items are real
 * <button>s so keyboard works for free. A future stage swaps in a
 * sub-menu-capable version only if a real need appears.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from './cx'
import './Menu.css'

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
}

export function Menu({ trigger, items, align = 'end' }: MenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="pix-menu-root" ref={rootRef}>
      <span
        className="pix-menu-trigger"
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen((v) => !v)
          }
        }}
      >
        {trigger}
      </span>
      {open && (
        <div className={cx('pix-menu', `pix-menu--${align}`)} role="menu">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={cx('pix-menu__item', item.danger && 'pix-menu__item--danger')}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onSelect()
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
