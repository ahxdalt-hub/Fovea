/**
 * Button and IconButton — the only button primitives in the app.
 *
 * Variants encode hierarchy: primary (one per view), secondary (default),
 * ghost (toolbar/icon), danger (destructive confirmations only). Sizes map
 * to control-height tokens so buttons align with fields on a shared grid.
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import './Button.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Renders leading/trailing content without affecting layout math. */
  iconStart?: ReactNode
  iconEnd?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  iconStart,
  iconEnd,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('pix-button', `pix-button--${variant}`, `pix-button--${size}`, className)}
      {...rest}
    >
      {iconStart && <span className="pix-button__icon">{iconStart}</span>}
      <span className="pix-button__label">{children}</span>
      {iconEnd && <span className="pix-button__icon">{iconEnd}</span>}
    </button>
  )
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name is required — the icon is decoration, not a label. */
  label: string
  variant?: 'ghost' | 'secondary'
  size?: ButtonSize
  active?: boolean
}

export function IconButton({
  label,
  variant = 'ghost',
  size = 'md',
  active = false,
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-pressed={active || undefined}
      className={cx(
        'pix-icon-button',
        `pix-icon-button--${variant}`,
        `pix-icon-button--${size}`,
        active && 'pix-icon-button--active',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}
