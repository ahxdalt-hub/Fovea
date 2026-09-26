/**
 * EnhanceControls (Stage 06) integration: the strip reflects the real job
 * lifecycle — readiness gating, the native-provided scale/mode choices,
 * progress from native tile counts, cancellation, failure/retry, and the
 * completion handoff to compare + export. The native calls are mocked at
 * the `invoke` boundary; a captured Tauri `Channel` lets the fake engine
 * stream events exactly like the real one does.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnhanceEventDto, EnhanceResultDto, InferenceStatusDto } from '../types/ipc'

const invoke = vi.fn()
let lastChannel: { onmessage?: (e: EnhanceEventDto) => void } | null = null
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => {
    // Capture the channel the bridge passed as `onEvent` — the same
    // object the native side streams through, minus the native side.
    const channel = (args as { onEvent?: unknown } | undefined)?.onEvent
    if (channel && typeof channel === 'object') lastChannel = channel as typeof lastChannel
    return invoke(cmd, args)
  },
  Channel: class {
    onmessage?: (e: EnhanceEventDto) => void
  },
}))

import { EnhanceControls } from './EnhanceControls'
import { AppStateProvider } from '../state/AppState'
import { NotificationProvider } from '../ui/Notifications'
import { useAppState } from '../state/useAppState'
import { useEnhance } from '../state/useEnhance'

const result: EnhanceResultDto = {
  imageId: 'a',
  filePath: 'C:/appdata/enhanced/job-1.png',
  width: 400,
  height: 300,
  label: '4× · Standard',
  engine: 'DirectML GPU',
  dataUrl: 'data:image/png;base64,RESULT',
}

/** Seed app state from a hook the tests control (like the view's own
 * bootstrap does), then render the real strip + real hook. */
function Harness({ seed }: { seed?: InferenceStatusDto }) {
  const { dispatch } = useAppState()
  const api = useEnhance()
  useEffect(() => {
    if (seed) dispatch({ type: 'inference/set', status: seed })
  }, [dispatch, seed])
  return (
    <EnhanceControls enhanceApi={api} selectedId="a" onExport={() => {}} onCompare={() => {}} />
  )
}

function renderHarness(seed?: InferenceStatusDto) {
  return render(
    <AppStateProvider>
      <NotificationProvider>
        <Harness seed={seed} />
      </NotificationProvider>
    </AppStateProvider>,
  )
}

const readyStatus: InferenceStatusDto = {
  device: 'DirectML GPU',
  models: [
    { id: 'm', label: 'Real-ESRGAN general', scale: 4, state: 'ready', mode: 'standard' },
    { id: 'w', label: 'Real-ESRGAN WDN', scale: 4, state: 'ready', mode: 'natural' },
  ],
  ready: true,
  scales: [2, 4],
  modes: [
    { key: 'standard', label: 'Standard', description: 'Reconstructs detail', available: true },
    { key: 'natural', label: 'Natural', description: 'Denoise-first', available: true },
    { key: 'detail', label: 'Detail', description: 'Standard + sharpen', available: true },
  ],
  modelsDirDisplay: 'C:/models',
}

const missingStatus: InferenceStatusDto = {
  ...readyStatus,
  ready: false,
  scales: [],
  modes: readyStatus.modes.map((m) => ({ ...m, available: false })),
  models: readyStatus.models.map((m) => ({ ...m, state: 'missing' })),
}

beforeEach(() => {
  invoke.mockReset()
  lastChannel = null
  // Pretend we are inside the desktop app for these flows.
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  localStorage.clear()
})

describe('EnhanceControls (Stage 06)', () => {
  it('is idle without a job and enables the primary action when the engine is ready', () => {
    renderHarness(readyStatus)
    expect(screen.getByRole('button', { name: /enhance 4×/i })).toBeEnabled()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('offers exactly the scales and modes the native status reports', () => {
    renderHarness(readyStatus)
    const scaleGroup = screen.getByRole('group', { name: 'Scale' })
    expect(scaleGroup).toHaveTextContent('2×')
    expect(scaleGroup).toHaveTextContent('4×')
    const modeGroup = screen.getByRole('group', { name: 'Mode' })
    expect(modeGroup).toHaveTextContent('Standard')
    expect(modeGroup).toHaveTextContent('Natural')
    expect(modeGroup).toHaveTextContent('Detail')
  })

  it('hides unavailable modes instead of offering a lie', () => {
    const partial: InferenceStatusDto = {
      ...readyStatus,
      modes: readyStatus.modes.map((m) => (m.key === 'natural' ? { ...m, available: false } : m)),
      models: readyStatus.models.filter((mo) => mo.mode !== 'natural'),
    }
    renderHarness(partial)
    expect(screen.queryByRole('radio', { name: 'Natural' })).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Standard' })).toBeInTheDocument()
  })

  it('explains the chosen mode with the native description', () => {
    renderHarness(readyStatus)
    // Default Standard's description shows under the strip (from native).
    expect(screen.getByText('Reconstructs detail')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Natural' }))
    expect(screen.getByText('Denoise-first')).toBeInTheDocument()
  })

  it('warns and disables when no model is installed', () => {
    renderHarness(missingStatus)
    expect(screen.getByRole('button', { name: /enhance 4×/i })).toBeDisabled()
    expect(screen.getByText(/ai model not installed/i)).toBeInTheDocument()
  })

  it('runs a full job with the chosen scale + mode: events drive the panel', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd !== 'enhance_image') return Promise.resolve(null)
      let settle: (r: EnhanceResultDto) => void = () => {}
      const pending = new Promise<EnhanceResultDto>((res) => {
        settle = res
      })
      // Stagger events so each intermediate state actually renders
      // (same-tick dispatches batch into one React update).
      setTimeout(() => {
        lastChannel?.onmessage?.({ phase: 'preparing', jobId: 'job-1-0' })
      }, 0)
      setTimeout(() => {
        lastChannel?.onmessage?.({ phase: 'processing', done: 1, total: 3 })
      }, 20)
      setTimeout(() => {
        lastChannel?.onmessage?.({ phase: 'processing', done: 3, total: 3 })
      }, 40)
      setTimeout(() => {
        lastChannel?.onmessage?.({ phase: 'completing' })
      }, 60)
      setTimeout(() => {
        lastChannel?.onmessage?.({ phase: 'completed' })
        settle(result)
      }, 80)
      return pending
    })
    renderHarness(readyStatus)

    // Choose 2× and Natural before running.
    fireEvent.click(screen.getByRole('radio', { name: '2×' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Natural' }))
    expect(screen.getByRole('button', { name: /enhance 2×/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /enhance 2×/i }))

    // The native call carries the chosen mode + scale.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'enhance_image',
        expect.objectContaining({ imageId: 'a', mode: 'natural', scale: 2 }),
      ),
    )
    // Preparing shows immediately (optimistically via enhance/start).
    expect(await screen.findByText(/preparing image…/i)).toBeInTheDocument()
    // Tile counts are displayed as measured, not faked.
    expect(await screen.findByText(/tile 3 of 3/i)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    // Completion: result headline + Compare and Export actions.
    expect(await screen.findByText(/in the compare view below/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^compare$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^export$/i })).toBeInTheDocument()
    expect(await screen.findByText(/enhanced to 400 × 300 on directml gpu/i)).toBeInTheDocument()
  })

  it('shows the engine device while processing, following a GPU→CPU retry', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd !== 'enhance_image') return Promise.resolve(null)
      setTimeout(() => {
        lastChannel?.onmessage?.({ phase: 'preparing', jobId: 'job-d' })
        lastChannel?.onmessage?.({ phase: 'device', device: 'DirectML GPU', tile: 256 })
        lastChannel?.onmessage?.({ phase: 'processing', done: 1, total: 4 })
      }, 0)
      setTimeout(() => {
        // The ladder downgraded mid-job: the chip must follow the truth.
        lastChannel?.onmessage?.({ phase: 'device', device: 'CPU', tile: 128 })
        lastChannel?.onmessage?.({ phase: 'processing', done: 2, total: 8 })
      }, 20)
      return new Promise<EnhanceResultDto>(() => {})
    })
    renderHarness(readyStatus)
    fireEvent.click(screen.getByRole('button', { name: /enhance 4×/i }))
    expect(await screen.findByText('GPU')).toBeInTheDocument()
    expect(await screen.findByText('Processor')).toBeInTheDocument()
  })

  it('cancel asks the native engine by job id and flags the panel', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'cancel_enhancement') return Promise.resolve(true)
      if (cmd !== 'enhance_image') return Promise.resolve(null)
      setTimeout(() => {
        lastChannel?.onmessage?.({ phase: 'preparing', jobId: 'job-7' })
        lastChannel?.onmessage?.({ phase: 'processing', done: 1, total: 9 })
      }, 0)
      return new Promise<EnhanceResultDto>(() => {
        /* never resolves — cancellation ends the job natively */
      })
    })
    renderHarness(readyStatus)
    fireEvent.click(screen.getByRole('button', { name: /enhance 4×/i }))

    const cancel = await screen.findByRole('button', { name: /^cancel$/i })
    fireEvent.click(cancel)
    expect(await screen.findByText(/cancelling…/i)).toBeInTheDocument()
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('cancel_enhancement', { jobId: 'job-7' }),
    )
    // The native terminal event settles the real state.
    lastChannel?.onmessage?.({ phase: 'cancelled' })
    expect(await screen.findByText(/^cancelled$/i)).toBeInTheDocument()
    expect(screen.getByText(/nothing was written/i)).toBeInTheDocument()
  })

  it('failed jobs surface the user-safe message with a retry action', async () => {
    const failure = { code: 'model_missing', message: 'The enhancement model is not installed.' }
    invoke.mockImplementation((cmd: string) => {
      if (cmd !== 'enhance_image') return Promise.resolve(null)
      setTimeout(() => {
        lastChannel?.onmessage?.({ phase: 'preparing', jobId: 'job-2' })
        lastChannel?.onmessage?.({ phase: 'failed', ...failure })
      }, 0)
      return Promise.reject(failure)
    })
    renderHarness(readyStatus)
    fireEvent.click(screen.getByRole('button', { name: /enhance 4×/i }))
    expect(await screen.findByText(failure.message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    // Dismiss clears the panel.
    fireEvent.click(screen.getByRole('button', { name: /dismiss error/i }))
    await waitFor(() => expect(screen.queryByText(failure.message)).toBeNull())
  })

  it('the button is honest outside the desktop runtime', () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    renderHarness(readyStatus)
    expect(screen.getByRole('button', { name: /enhance 4×/i })).toBeDisabled()
  })

  it('persists the user’s choices across a remount', () => {
    const first = renderHarness(readyStatus)
    fireEvent.click(screen.getByRole('radio', { name: '2×' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Detail' }))
    expect(screen.getByRole('button', { name: /enhance 2×/i })).toBeInTheDocument()
    first.unmount()
    // A fresh workspace session (as after navigation) reads back the choice.
    renderHarness(readyStatus)
    expect(screen.getByRole('button', { name: /enhance 2×/i })).toBeInTheDocument()
    expect((screen.getByRole('radio', { name: 'Detail' }) as HTMLInputElement).checked).toBe(true)
  })
})
