/**
 * Small pill showing the native-core connection state. Honest indicator —
 * it reflects the real bootstrap result, never a decorative fake.
 */
import type { CoreStatus } from '../state/appReducer'
import './StatusDot.css'

export function StatusDot({ status }: { status: CoreStatus }) {
  const label =
    status === 'ready' ? 'Core connected' : status === 'connecting' ? 'Connecting…' : 'Core error'
  return (
    <span className={`status-dot status-dot--${status}`} role="status" aria-live="polite">
      <span className="status-dot__glyph" aria-hidden="true" />
      {label}
    </span>
  )
}
