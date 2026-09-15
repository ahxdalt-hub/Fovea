/**
 * Progress primitives.
 *
 * ProgressBar: determinate (value 0–100) or indeterminate (queued/unknown).
 * Spinner: compact inline activity (buttons, status areas). Both are role
 * progressbar with aria attributes so assistive tech reads real values.
 */
import { cx } from './cx'
import './Progress.css'

export interface ProgressBarProps {
  /** 0–100. Omit for an indeterminate sweep. */
  value?: number
  label: string
  className?: string
}

export function ProgressBar({ value, label, className }: ProgressBarProps) {
  const indeterminate = value == null
  return (
    <div
      className={cx('pix-progress', indeterminate && 'pix-progress--indeterminate', className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
    >
      <span
        className="pix-progress__fill"
        style={indeterminate ? undefined : { width: `${value}%` }}
      />
    </div>
  )
}

export interface SpinnerProps {
  label?: string
  className?: string
}

export function Spinner({ label, className }: SpinnerProps) {
  return (
    <span
      className={cx('pix-spinner', className)}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}
