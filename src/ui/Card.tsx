/**
 * Surface primitives — Card and Panel.
 *
 * Card: content island with border + soft shadow (empty state, info blocks).
 * Panel: a titled region of the workspace (future side panels, lists).
 * Keeping both here prevents every view inventing its own box.
 */
import type { HTMLAttributes, ReactNode } from 'react'
import { cx } from './cx'
import './Card.css'

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode
}

export function Card({ className, children, ...rest }: CardProps) {
  return (
    <div className={cx('pix-card', className)} {...rest}>
      {children}
    </div>
  )
}

export interface PanelProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Rendered as the panel's accessible name when it is a landmark. */
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
}

export function Panel({ title, actions, className, children, ...rest }: PanelProps) {
  return (
    <section
      className={cx('pix-panel', className)}
      aria-label={typeof title === 'string' ? title : undefined}
      {...rest}
    >
      {(title || actions) && (
        <header className="pix-panel__header">
          {title && <h2 className="pix-panel__title">{title}</h2>}
          {actions && <div className="pix-panel__actions">{actions}</div>}
        </header>
      )}
      <div className="pix-panel__body">{children}</div>
    </section>
  )
}
