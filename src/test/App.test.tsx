/**
 * Shell integration tests: render the full app with the IPC bridge mocked
 * and prove the shell reacts to real startup state, navigation, dialogs,
 * and keyboard shortcuts.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  Channel: class {
    onmessage: unknown = null
  },
}))

import App from '../App'
import { AppStateProvider } from '../state/AppState'

function renderApp() {
  return render(
    <AppStateProvider>
      <App />
    </AppStateProvider>,
  )
}

function mockSuccessfulCore() {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === 'get_config')
      return Promise.resolve({
        productName: 'Pixora',
        version: '0.2.0',
        identifier: 'com.pixora.desktop',
        debug: true,
      })
    if (cmd === 'get_system_info')
      return Promise.resolve({
        osFamily: 'windows',
        arch: 'x86_64',
        appDataDir: 'C:/Users/test/AppData',
      })
    if (cmd === 'write_frontend_log') return Promise.resolve(null)
    return Promise.reject(new Error(`unexpected command: ${cmd}`))
  })
}

function navButton(label: string): HTMLElement {
  const nav = screen.getByRole('navigation', { name: 'Primary' })
  const match = Array.from(nav.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(label),
  )
  if (!match) throw new Error(`no nav button containing "${label}"`)
  return match
}

describe('Pixora shell', () => {
  beforeEach(() => {
    invoke.mockReset()
    localStorage.clear()
  })

  it('completes the handshake and shows the Enhance empty workspace', async () => {
    mockSuccessfulCore()
    renderApp()

    expect(await screen.findByText(/core connected/i)).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /drop an image anywhere to begin/i }),
    ).toBeInTheDocument()
    // In a non-Tauri runtime (jsdom) there is no native core, so the
    // picker is honestly disabled — no faked imports.
    expect(screen.getByRole('button', { name: /choose files/i })).toBeDisabled()
    // The privacy promise is visible without opening settings.
    expect(screen.getByText(/never leave this computer/i)).toBeInTheDocument()
    expect(screen.getByText(/windows · x86_64/i)).toBeInTheDocument()
  })

  it('navigates between the three primary views', async () => {
    mockSuccessfulCore()
    renderApp()
    await screen.findByText(/core connected/i)

    fireEvent.click(navButton('Batch'))
    expect(screen.getByRole('heading', { level: 1, name: 'Batch' })).toBeInTheDocument()

    fireEvent.click(navButton('History'))
    expect(screen.getByRole('heading', { level: 1, name: 'History' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /open enhance/i })).toBeInTheDocument()

    fireEvent.click(navButton('Enhance'))
    expect(screen.getByRole('button', { name: /choose files/i })).toBeInTheDocument()
  })

  it('switches views with keyboard shortcuts 1/2/3', async () => {
    mockSuccessfulCore()
    renderApp()
    await screen.findByText(/core connected/i)

    fireEvent.keyDown(window, { key: '2' })
    expect(screen.getByRole('heading', { level: 1, name: 'Batch' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: '1' })
    expect(screen.getByRole('button', { name: /choose files/i })).toBeInTheDocument()
  })

  it('opens settings with Ctrl+comma and toggles theme', async () => {
    mockSuccessfulCore()
    renderApp()
    await screen.findByText(/core connected/i)

    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    expect(dialog).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(localStorage.getItem('pixora:theme')).toBe('dark')

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Settings' })).not.toBeInTheDocument(),
    )
  })

  it('returns focus to the trigger when a dialog closes', async () => {
    mockSuccessfulCore()
    renderApp()
    await screen.findByText(/core connected/i)

    const gear = screen.getByRole('button', { name: 'Settings' })
    gear.focus()
    fireEvent.click(gear)
    const dialog = await screen.findByRole('dialog', { name: 'Settings' })
    expect(dialog).toContainElement(document.activeElement as HTMLElement | null)

    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(document.activeElement).toBe(gear))
  })

  it('suspends navigation shortcuts while a dialog is open', async () => {
    mockSuccessfulCore()
    renderApp()
    await screen.findByText(/core connected/i)

    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    await screen.findByRole('dialog', { name: 'Settings' })

    // The workspace must not change underneath the modal.
    fireEvent.keyDown(window, { key: '2' })
    expect(screen.queryByRole('heading', { level: 1, name: 'Batch' })).not.toBeInTheDocument()
  })

  it('labels top-bar menu triggers for assistive tech', async () => {
    mockSuccessfulCore()
    renderApp()
    await screen.findByText(/core connected/i)
    expect(screen.getByRole('button', { name: 'Theme' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument()
  })

  it('shows a retryable error surface when the core is unreachable', async () => {
    invoke.mockImplementation(() =>
      Promise.reject({ code: 'unexpected_error', message: 'core unavailable message' }),
    )

    renderApp()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('core unavailable message')
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })

  it('opens the shortcuts dialog with F1', async () => {
    mockSuccessfulCore()
    renderApp()
    await screen.findByText(/core connected/i)

    fireEvent.keyDown(window, { key: 'F1' })
    expect(await screen.findByRole('dialog', { name: /keyboard shortcuts/i })).toBeInTheDocument()
  })
})
