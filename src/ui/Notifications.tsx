/**
 * Notifications — transient toasts for operation results.
 *
 * A context provider owns the queue; callers push non-technical messages
 * via `useNotify` (see notificationContext.ts). They stack bottom-right,
 * auto-dismiss after a tone-appropriate delay, and are dismissible.
 * Reduced motion is handled globally; timers stay because dismissal is
 * functional, not decorative.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from './cx'
import { IconCheck, IconClose, IconInfo, IconWarning } from './Icons'
import { NotificationContext, type NotificationTone } from './notificationContext'
import './Notifications.css'

interface Notification {
  id: number
  tone: NotificationTone
  message: string
}

const AUTO_DISMISS_MS: Record<NotificationTone, number> = {
  info: 5000,
  success: 4000,
  warning: 6000,
  error: 8000,
}

let nextId = 1

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Notification[]>([])
  const timers = useRef(new Map<number, number>())

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((n) => n.id !== id))
    const timer = timers.current.get(id)
    if (timer != null) {
      window.clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const notify = useCallback(
    (tone: NotificationTone, message: string) => {
      const id = nextId++
      setItems((list) => [...list.slice(-3), { id, tone, message }])
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS[tone]),
      )
    },
    [dismiss],
  )

  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach((t) => window.clearTimeout(t))
      map.clear()
    }
  }, [])

  return (
    <NotificationContext.Provider value={{ notify }}>
      {children}
      <div
        className="pix-notifications"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        {items.map((item) => (
          <NotificationCard key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </NotificationContext.Provider>
  )
}

const toneIcon: Record<NotificationTone, ReactNode> = {
  info: <IconInfo size="sm" />,
  success: <IconCheck size="sm" />,
  warning: <IconWarning size="sm" />,
  error: <IconWarning size="sm" />,
}

function NotificationCard({
  item,
  onDismiss,
}: {
  item: Notification
  onDismiss: (id: number) => void
}) {
  return (
    <div className={cx('pix-notification', `pix-notification--${item.tone}`)}>
      <span className="pix-notification__icon">{toneIcon[item.tone]}</span>
      <p className="pix-notification__message">{item.message}</p>
      <button
        type="button"
        className="pix-notification__close"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
      >
        <IconClose size="sm" />
      </button>
    </div>
  )
}
