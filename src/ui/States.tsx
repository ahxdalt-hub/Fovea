/**
 * Workspace state views — the three honest non-content states every view
 * will need: empty (nothing imported yet), loading (work in flight), and
 * error (something failed, with a retry path).
 */
import type { ReactNode } from 'react'
import { cx } from './cx'
import { Button } from './Button'
import { Spinner } from './Progress'
import { IconRetry } from './Icons'
import './States.css'

export interface EmptyStateProps {
  icon: ReactNode
  title: string
  description: ReactNode
  actions?: ReactNode
  className?: string
}

export function EmptyState({ icon, title, description, actions, className }: EmptyStateProps) {
  return (
    <div className={cx('pix-state pix-state--empty anim-rise', className)}>
      <div className="pix-state__dropzone">
        <span className="pix-state__icon">{icon}</span>
      </div>
      <h2 className="pix-state__title">{title}</h2>
      <p className="pix-state__description">{description}</p>
      {actions && <div className="pix-state__actions">{actions}</div>}
    </div>
  )
}

export interface LoadingStateProps {
  label: string
  description?: string
}

export function LoadingState({ label, description }: LoadingStateProps) {
  return (
    <div className="pix-state pix-state--loading" role="status">
      <Spinner label={label} />
      <p className="pix-state__description">{description ?? label}</p>
    </div>
  )
}

export interface ErrorStateProps {
  title: string
  description: string
  onRetry?: () => void
  /** Extra recovery actions below retry (e.g. open log, change settings). */
  actions?: ReactNode
}

export function ErrorState({ title, description, onRetry, actions }: ErrorStateProps) {
  return (
    <div className="pix-state pix-state--error anim-rise" role="alert">
      <h2 className="pix-state__title">{title}</h2>
      <p className="pix-state__description">{description}</p>
      <div className="pix-state__actions">
        {onRetry && (
          <Button variant="primary" iconStart={<IconRetry size="sm" />} onClick={onRetry}>
            Try again
          </Button>
        )}
        {actions}
      </div>
    </div>
  )
}
