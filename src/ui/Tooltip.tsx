/**
 * Tooltip — hover/focus reveal for icon-only and compact controls.
 *
 * CSS-driven with a small open delay so accidental sweeps don't flash
 * tips; appears instantly from keyboard focus. Not for long-form text:
 * keep tooltips to one short sentence.
 */
import type { ReactNode } from 'react'
import { cx } from './cx'
import './Tooltip.css'

export interface TooltipProps {
  content: ReactNode
  side?: 'top' | 'bottom'
  /**
   * Horizontal anchoring. `end` right-aligns the bubble to the trigger —
   * use it for controls near the window's right edge so the tooltip never
   * overflows the viewport (body is overflow:hidden, so it would clip).
   */
  align?: 'center' | 'end'
  children: ReactNode
  className?: string
}

export function Tooltip({
  content,
  side = 'top',
  align = 'center',
  children,
  className,
}: TooltipProps) {
  if (!content) return <>{children}</>
  return (
    <span
      className={cx(
        'pix-tooltip-wrap',
        `pix-tooltip-wrap--${side}`,
        align === 'end' && 'pix-tooltip-wrap--align-end',
        className,
      )}
      tabIndex={-1}
    >
      {children}
      <span role="tooltip" className="pix-tooltip" aria-hidden="true">
        {content}
      </span>
    </span>
  )
}
