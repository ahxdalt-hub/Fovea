/**
 * Notifications — transient toasts for operation results.
 *
 * A context provider owns the queue; callers push non-technical messages
 * via `useNotify` (see notificationContext.ts). They stack bottom-right,
 * auto-dismiss after a tone-appropriate delay, and are dismissible.
 * Hovering a toast pauses its clock and leaving resumes it briefly — a
 * toast never vanishes under the cursor. Exit is animated (a short
 * settle), so removal never reads as a glitch. Reduced motion is handled
 * globally; timers stay because dismissal is functional, not decorative.
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
  /** Exit in progress: visually leaving, awaiting unmount. */
  leaving?: boolean
}

const AUTO_DISMISS_MS: Record<NotificationTone, number> = {
  info: 5000,
  success: 4000,
  warning: 6000,
  error: 8000,
}

/** Exit animation length (matches Notifications.css). */
const EXIT_MS = 150
/** Grace period granted after a hover pauses the clock. */
const RESUME_MS = 1600

let nextId = 1

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Notification[]>([])
  const timers = useRef(new Map<number, number>())
  const exitTimers = useRef(new Set<number>())
  const leaving = useRef(new Set<number>())

  const remove = useCallback((id: number) => {
    setItems((list) => list.filter((n) => n.id !== id))
    timers.current.delete(id)
    leaving.current.delete(id)
  }, [])

  /** Begin the animated exit; the id is removed shortly after. */
  const dismiss = useCallback(
    (id: number) => {
      if (leaving.current.has(id)) return
      leaving.current.add(id)
      const pending = timers.current.get(id)
      if (pending != null) {
        window.clearTimeout(pending)
        timers.current.delete(id)
      }
      const timer = window.setTimeout(() => remove(id), EXIT_MS)
      exitTimers.current.add(timer)
      setItems((list) => list.map((n) => (n.id === id ? { ...n, leaving: true } : n)))
    },
    [remove],
  )

  /** Hovering holds the toast; leaving grants a short final grace. */
  const pause = useCallback((id: number) => {
    const pending = timers.current.get(id)
    if (pending != null) {
      window.clearTimeout(pending)
      timers.current.delete(id)
    }
  }, [])

  const resume = useCallback(
    (id: number) => {
      if (leaving.current.has(id) || timers.current.has(id)) return
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), RESUME_MS),
      )
    },
    [dismiss],
  )

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
    const auto = timers.current
    const exits = exitTimers.current
    return () => {
      auto.forEach((t) => window.clearTimeout(t))
      auto.clear()
      exits.forEach((t) => window.clearTimeout(t))
      exits.clear()
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
          <NotificationCard
            key={item.id}
            item={item}
            onDismiss={dismiss}
            onPause={pause}
            onResume={resume}
          />
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
  onPause,
  onResume,
}: {
  item: Notification
  onDismiss: (id: number) => void
  onPause: (id: number) => void
  onResume: (id: number) => void
}) {
  return (
    <div
      className={cx(
        'pix-notification',
        `pix-notification--${item.tone}`,
        item.leaving && 'pix-notification--leaving',
      )}
      onMouseEnter={() => onPause(item.id)}
      onMouseLeave={() => onResume(item.id)}
    >
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
