/**
 * ExportDialog (Stage 06) tests: format choice drives the quality control
 * (PNG honestly hides it), the folder choice flows into the native call,
 * success lands in app state + notification + close, and failures stay
 * visible in the dialog with user-safe text.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExportResultDto } from '../types/ipc'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  Channel: class {
    onmessage: unknown = null
  },
}))

import { ExportDialog } from './ExportDialog'
import { AppStateProvider } from '../state/AppState'
import { NotificationProvider } from '../ui/Notifications'
import { useAppState } from '../state/useAppState'

const exportResult: ExportResultDto = {
  filePath: 'C:/Users/me/Pictures/sunset.jpg',
  fileName: 'sunset.jpg',
  folder: 'C:/Users/me/Pictures',
  format: 'jpeg',
  bytes: 2_400_000,
}

/** Harness reads `exports` from the same provider the dialog writes to,
 * proving the app-state handoff is real. */
function Harness({ onClosed }: { onClosed?: (r: ExportResultDto) => void }) {
  const { state } = useAppState()
  return (
    <>
      <ExportDialog
        open
        onClose={() => {}}
        imageId="C:/photos/sunset.png"
        imageName="sunset.png"
        resultWidth={4000}
        resultHeight={3000}
        resultLabel="4× · Standard"
        onExported={onClosed}
      />
      <div data-testid="state-probe">
        {state.exports['C:/photos/sunset.png']?.filePath ?? 'none'}
      </div>
    </>
  )
}

function renderDialog(onClosed?: (r: ExportResultDto) => void) {
  return render(
    <AppStateProvider>
      <NotificationProvider>
        <Harness onClosed={onClosed} />
      </NotificationProvider>
    </AppStateProvider>,
  )
}

beforeEach(() => {
  invoke.mockReset()
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  localStorage.clear()
})

describe('ExportDialog', () => {
  it('offers PNG/JPEG/WebP with quality hidden for PNG', () => {
    renderDialog()
    expect(screen.getByRole('group', { name: 'Format' })).toHaveTextContent('PNG')
    expect(screen.getByRole('group', { name: 'Format' })).toHaveTextContent('JPEG')
    expect(screen.getByRole('group', { name: 'Format' })).toHaveTextContent('WebP')
    // Default PNG → no quality control (its export is a lossless copy).
    expect(screen.queryByRole('slider', { name: /quality/i })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'JPEG' }))
    expect(screen.getByLabelText(/quality/i)).toBeInTheDocument()
  })

  it('quality is a real slider bound to the native call', () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'export_enhanced_image') return Promise.resolve(exportResult)
      return Promise.resolve(null)
    })
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'JPEG' }))
    const slider = screen.getByLabelText(/quality/i) as HTMLInputElement
    fireEvent.change(slider, { target: { value: '62' } })
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }))
    return waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('export_enhanced_image', {
        imageId: 'C:/photos/sunset.png',
        format: 'jpeg',
        quality: 62,
        folder: '',
      }),
    )
  })

  it('successful export records the result, notifies, and closes', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'export_enhanced_image') return Promise.resolve(exportResult)
      return Promise.resolve(null)
    })
    const onExported = vi.fn()
    renderDialog(onExported)
    fireEvent.click(screen.getByRole('radio', { name: 'JPEG' }))
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }))
    expect(await screen.findByText(/saved sunset\.jpg/i)).toBeInTheDocument()
    expect(onExported).toHaveBeenCalledWith(exportResult)
  })

  it('failed export keeps the dialog open with the user-safe message', async () => {
    const failure = { code: 'permission_denied', message: 'Windows won’t let Pixora write there.' }
    invoke.mockImplementation((cmd: string) =>
      cmd === 'export_enhanced_image' ? Promise.reject(failure) : Promise.resolve(null),
    )
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }))
    expect(await screen.findByText(failure.message)).toBeInTheDocument()
    // The result state stays empty — no fake success.
    expect(screen.getByTestId('state-probe').textContent).toBe('none')
  })

  it('folder change flows into the native export call', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'pick_export_folder') return Promise.resolve(['D:/Exports'])
      if (cmd === 'export_enhanced_image') return Promise.resolve(exportResult)
      return Promise.resolve(null)
    })
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /change…/i }))
    expect(await screen.findByText('D:/Exports')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^export$/i }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'export_enhanced_image',
        expect.objectContaining({ folder: 'D:/Exports' }),
      ),
    )
  })
})
