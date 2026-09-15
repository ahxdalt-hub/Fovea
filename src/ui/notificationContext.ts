/**
 * Raw notification context, kept component-free so the provider and the
 * useNotify hook live in separate modules (fast-refresh friendly, mirrors
 * the appStateContext pattern).
 */
import { createContext, useContext } from 'react'

export type NotificationTone = 'info' | 'success' | 'warning' | 'error'

export interface NotifyApi {
  notify: (tone: NotificationTone, message: string) => void
}

export const NotificationContext = createContext<NotifyApi | null>(null)

/** Push a notification from anywhere inside the provider. */
export function useNotify(): NotifyApi {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotify must be used inside <NotificationProvider>')
  return ctx
}
