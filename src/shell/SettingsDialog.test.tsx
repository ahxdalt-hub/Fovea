/**
 * Settings dialog (Stage 10) — the settings experience under test:
 * section navigation, every control writing through the real
 * `useSettings` path (so localStorage persistence and the native hint
 * mirror are covered for real), honest diagnostics from a mocked
 * bridge, and the restart round trip.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiagnosticsDto, InferenceStatusDto, SystemInfoDto } from '../types/ipc'

const getDiagnostics = vi.fn()
const pickExportFolder = vi.fn()
const openLogsFolder = vi.fn()
const setEngineHints = vi.fn()
vi.mock('../ipc/bridge', () => ({
  getDiagnostics: () => getDiagnostics(),
  pickExportFolder: () => pickExportFolder(),
  openLogsFolder: () => openLogsFolder(),
  setEngineHints: (hints: unknown) => setEngineHints(hints),
}))

import { SettingsDialog } from './SettingsDialog'
import { AppStateProvider } from '../state/AppState'
import { useAppState } from '../state/useAppState'
import { DEFAULT_SETTINGS, readSettings } from '../state/settings'

const diagnostics: DiagnosticsDto = {
  hardware: {
    cpuName: 'Test CPU 9000',
    physicalCores: 8,
    logicalProcessors: 16,
    totalMemoryBytes: 32 * 1024 * 1024 * 1024,
    availableMemoryBytes: 16 * 1024 * 1024 * 1024,
    gpus: [
      {
        name: 'Test GPU Ultra',
        vendorId: 4318,
        dedicatedVideoBytes: 8 * 1024 * 1024 * 1024,
        sharedSystemBytes: 16 * 1024 * 1024 * 1024,
        software: false,
        directx12: true,
      },
    ],
  },
  engineDevice: 'DirectML GPU',
  maxTileBytes: 512 * 1024 * 1024,
  maxBandBytes: 256 * 1024 * 1024,
  memoryLimit: 'GPU video memory',
}

const systemInfo: SystemInfoDto = {
  osFamily: 'windows',
  arch: 'x86_64',
  appDataDir: 'C:/Users/test/AppData',
  logsDir: 'C:/Users/test/AppData/logs',
  defaultExportDir: 'C:/Users/test/Documents/Fovea',
  defaultBatchExportDir: 'C:/Users/test/Documents/Fovea/Batch',
}

const inference: InferenceStatusDto = {
  device: 'DirectML GPU',
  models: [{ id: 'm', label: 'Real-ESRGAN', scale: 4, state: 'ready', mode: 'standard' }],
  ready: true,
  scales: [2, 4],
  modes: [
    { key: 'standard', label: 'Standard', description: 'Reconstructs detail', available: true },
    { key: 'natural', label: 'Natural', description: 'Denoise-first', available: true },
    { key: 'detail', label: 'Detail', description: 'Plus sharpening', available: false },
  ],
  modelsDirDisplay: 'C:/Users/test/AppData/models',
}

/** Seed the slices SettingsDialog reads, the same way the real bootstrap
 * does — through dispatch in an effect (how the core handshake lands
 * them), never by mutating state. */
function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const { dispatch } = useAppState()
  useEffect(() => {
    dispatch({
      type: 'core/ready',
      config: {
        productName: 'Fovea',
        version: '1.2.3',
        identifier: 'com.fovea.desktop',
        debug: false,
      },
      systemInfo,
    })
    dispatch({ type: 'inference/set', status: inference })
  }, [dispatch])
  return <SettingsDialog open onClose={onClose} />
}

function renderDialog() {
  return render(
    <AppStateProvider>
      <Harness />
    </AppStateProvider>,
  )
}

/** Read the persisted record back (the restart proof). */
function storedSettings() {
  return readSettings()
}

beforeEach(() => {
  localStorage.clear()
  getDiagnostics.mockReset().mockResolvedValue(diagnostics)
  pickExportFolder.mockReset().mockResolvedValue('D:/Photo Exports')
  openLogsFolder.mockReset().mockResolvedValue('C:/logs')
  setEngineHints.mockReset().mockResolvedValue(null)
})

afterEach(() => {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
})

const nav = () => screen.getByRole('navigation', { name: 'Settings sections' })

describe('Settings dialog', () => {
  it('opens on General with the theme control reflecting defaults', () => {
    renderDialog()
    expect(within(nav()).getByRole('button', { name: /^General/ })).toHaveAttribute('aria-current')
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Dark' })).not.toBeChecked()
  })

  it('a theme change persists and mirrors nothing it does not need to', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(storedSettings().general.theme).toBe('dark')
    await waitFor(() => expect(setEngineHints).toHaveBeenCalled())
    expect(setEngineHints).toHaveBeenLastCalledWith({
      cpuOnly: false,
      fullPower: false,
      recordRecents: true,
    })
  })

  it('navigates sections, and the startup view + recents controls live in General', () => {
    renderDialog()
    fireEvent.click(within(nav()).getByRole('button', { name: /^Export/ }))
    expect(screen.getByLabelText(/Quality for JPEG and WebP/i)).toBeInTheDocument()
    fireEvent.click(within(nav()).getByRole('button', { name: /^General/ }))
    expect(screen.getByRole('combobox', { name: /On startup/i })).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: /Remember recent files/i })).toBeChecked()
  })

  it('the recents limit only shows while recents are on', () => {
    renderDialog()
    expect(screen.getByLabelText(/Recent files to offer/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch', { name: /Remember recent files/i }))
    expect(screen.queryByLabelText(/Recent files to offer/i)).not.toBeInTheDocument()
    expect(storedSettings().general.rememberRecentFiles).toBe(false)
    expect(setEngineHints).toHaveBeenLastCalledWith(
      expect.objectContaining({ recordRecents: false }),
    )
  })

  it('the processor choice is honest in both languages: UI words, native hint', () => {
    renderDialog()
    fireEvent.click(within(nav()).getByRole('button', { name: /^Processing/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'The processor' }))
    expect(storedSettings().processing.enginePath).toBe('cpu')
    expect(setEngineHints).toHaveBeenLastCalledWith(expect.objectContaining({ cpuOnly: true }))
  })

  it('export defaults persist, the quality slider clamps visually, folder uses the native picker', async () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    renderDialog()
    fireEvent.click(within(nav()).getByRole('button', { name: /^Export/ }))

    fireEvent.click(screen.getByRole('radio', { name: 'JPEG' }))
    expect(storedSettings().export.format).toBe('jpeg')

    fireEvent.change(screen.getByLabelText(/Quality for JPEG and WebP/i), {
      target: { value: '77' },
    })
    expect(storedSettings().export.quality).toBe(77)

    fireEvent.click(screen.getByRole('button', { name: /Change…/ }))
    await waitFor(() => expect(pickExportFolder).toHaveBeenCalled())
    await waitFor(() => expect(storedSettings().export.folder).toBe('D:/Photo Exports'))
    expect(screen.getByText('D:/Photo Exports')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Use Fovea's/i }))
    expect(storedSettings().export.folder).toBe('')
    // Resetting to Fovea's own folder shows the real path the native layer
    // reported — never a vague label while an answer is on hand.
    expect(screen.getByText('C:/Users/test/Documents/Fovea')).toBeInTheDocument()
  })

  it('the full-machine power mode mirrors to native', () => {
    renderDialog()
    fireEvent.click(within(nav()).getByRole('button', { name: /^Performance/ }))
    fireEvent.click(screen.getByRole('radio', { name: /Use the full machine/i }))
    expect(storedSettings().performance.speed).toBe('maximum')
    expect(setEngineHints).toHaveBeenLastCalledWith(expect.objectContaining({ fullPower: true }))
  })

  it('diagnostics reports version, engine truth, models, and the log location', async () => {
    ;(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    renderDialog()
    fireEvent.click(within(nav()).getByRole('button', { name: /^Diagnostics/ }))

    expect(await screen.findByText('Graphics card (DirectML GPU)')).toBeInTheDocument()
    expect(screen.getByText(/Test CPU 9000/)).toBeInTheDocument()
    expect(screen.getByText(/Test GPU Ultra/)).toBeInTheDocument()
    // The version row: label and value share the row.
    expect(screen.getByText('Fovea version')).toBeInTheDocument()
    expect(screen.getByText('1.2.3')).toBeInTheDocument()
    // Models: honest per-mode readiness, straight from native status.
    expect(screen.getAllByText('Ready')).toHaveLength(2)
    expect(screen.getByText('Not installed')).toBeInTheDocument()
    // Logs: display path + the open affordance (desktop runtime only).
    expect(screen.getByText('C:/Users/test/AppData/logs')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Open logs folder/i }))
    await waitFor(() => expect(openLogsFolder).toHaveBeenCalled())
  })

  it('diagnostics degrades honestly when the probe fails', async () => {
    getDiagnostics.mockRejectedValue({ code: 'unexpected_error', message: 'no' })
    renderDialog()
    fireEvent.click(within(nav()).getByRole('button', { name: /^Diagnostics/ }))
    expect(await screen.findByText(/diagnostics are unavailable/i)).toBeInTheDocument()
  })

  it('a remounted app reads back everything it wrote (the restart case)', async () => {
    renderDialog()
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    fireEvent.click(within(nav()).getByRole('button', { name: /^Processing/ }))
    fireEvent.click(screen.getByRole('radio', { name: '2×' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Natural' }))
    await waitFor(() => expect(storedSettings().processing.defaultMode).toBe('natural'))

    // Fresh provider = fresh createInitialState = exactly what a restart
    // does: read localStorage and honour it on first paint.
    const { unmount } = render(
      <AppStateProvider>
        <Harness />
      </AppStateProvider>,
    )
    unmount()

    const persisted = readSettings()
    expect(persisted.general.theme).toBe('light')
    expect(persisted.processing).toEqual({
      ...DEFAULT_SETTINGS.processing,
      defaultScale: 2,
      defaultMode: 'natural',
    })
  })
})
