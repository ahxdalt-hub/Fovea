/**
 * Badge — compact status vocabulary (GPU, format, count pills).
 */
import type { ReactNode } from 'react'
import { cx } from './cx'
import './Badge.css'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export interface BadgeProps {
  tone?: BadgeTone
  children: ReactNode
  className?: string
  /** Leading dot for status semantics (color alone is never the signal). */
  dot?: boolean
  title?: string
}

export function Badge({ tone = 'neutral', dot = false, children, className, title }: BadgeProps) {
  return (
    <span className={cx('pix-badge', `pix-badge--${tone}`, className)} title={title}>
      {dot && <span className="pix-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  )
}
