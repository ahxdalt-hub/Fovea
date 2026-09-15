/**
 * Notifications: tone styling, manual dismissal, auto-dismiss timing,
 * and the stack cap. Vitest fake timers drive the delays.
 */
import type { ReactElement } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NotificationProvider } from './Notifications'
import { useNotify, type NotificationTone } from './notificationContext'

function Pusher({ tone, message }: { tone: NotificationTone; message: string }) {
  const { notify } = useNotify()
  return (
    <button type="button" onClick={() => notify(tone, message)}>
      push {message}
    </button>
  )
}

function renderWithProvider(ui: ReactElement) {
  return render(<NotificationProvider>{ui}</NotificationProvider>)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('NotificationProvider', () => {
  it('shows a tone-labelled toast when notify is called', () => {
    vi.useFakeTimers()
    renderWithProvider(<Pusher tone="success" message="Export finished" />)
    fireEvent.click(screen.getByRole('button', { name: /push Export/ }))
    const toast = screen.getByText('Export finished')
    expect(toast.closest('.pix-notification--success')).toBeTruthy()
  })

  it('dismisses on the close button', () => {
    renderWithProvider(<Pusher tone="info" message="Short-lived" />)
    fireEvent.click(screen.getByRole('button', { name: /push Short/ }))
    expect(screen.getByText('Short-lived')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))
    expect(screen.queryByText('Short-lived')).not.toBeInTheDocument()
  })

  it('auto-dismisses after the tone-specific delay', () => {
    vi.useFakeTimers()
    renderWithProvider(<Pusher tone="info" message="Timed out" />)
    fireEvent.click(screen.getByRole('button', { name: /push Timed/ }))
    expect(screen.getByText('Timed out')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(screen.queryByText('Timed out')).not.toBeInTheDocument()
  })

  it('keeps the newest four toasts when many are pushed at once', () => {
    renderWithProvider(<Pusher tone="info" message="msg" />)
    const btn = screen.getByRole('button', { name: /push msg/ })
    for (let i = 0; i < 5; i++) fireEvent.click(btn)
    const region = screen.getByRole('region', { name: 'Notifications' })
    expect(region.querySelectorAll('.pix-notification')).toHaveLength(4)
  })
})
