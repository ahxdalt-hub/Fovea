/**
 * Sanity integration test: render the full App shell with the IPC bridge
 * mocked and prove the UI reacts to a successful native handshake.
 * This is the "application foundation works" proof required by Stage 01.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
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

describe('App shell', () => {
  beforeEach(() => {
    invoke.mockReset()
  })

  it('completes startup handshake and shows real system info', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_config')
        return Promise.resolve({
          productName: 'Local AI Image Upscaler',
          version: '0.1.0',
          identifier: 'com.localaiimageupscaler.desktop',
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

    renderApp()
    expect(await screen.findByText(/core connected/i)).toBeInTheDocument()
    expect(screen.getByText('windows')).toBeInTheDocument()
    expect(screen.getByText('x86_64')).toBeInTheDocument()
    // Log relay happened at least once during bootstrap.
    expect(invoke).toHaveBeenCalledWith('write_frontend_log', expect.anything())
  })

  it('shows a calm error card when the native core is unreachable', async () => {
    invoke.mockImplementation(() =>
      Promise.reject({ code: 'unexpected_error', message: 'core unavailable message' }),
    )

    renderApp()
    const card = await screen.findByLabelText('Startup error')
    expect(card).toHaveTextContent('core unavailable message')
    // No raw rejection text or paths should leak through the error UI.
    expect(card).not.toHaveTextContent('Error:')
  })
})
