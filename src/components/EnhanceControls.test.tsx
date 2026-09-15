/**
 * EnhanceControls (Stage 05) integration: the strip reflects the real
 * job lifecycle — readiness gating, progress from native tile counts,
 * cancellation, and failure/retry. The native calls are mocked at the
 * `invoke` boundary; a captured Tauri `Channel` lets the fake engine
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
  label: '4× · Real-ESRGAN general',
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
  return <EnhanceControls enhanceApi={api} selectedId="a" />
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
  models: [{ id: 'm', label: 'Real-ESRGAN general', scale: 4, state: 'ready' }],
  ready: true,
  modelsDirDisplay: 'C:/models',
}

const missingStatus: InferenceStatusDto = {
  ...readyStatus,
  ready: false,
  models: [{ id: 'm', label: 'Real-ESRGAN general', scale: 4, state: 'missing' }],
}

beforeEach(() => {
  invoke.mockReset()
  lastChannel = null
  // Pretend we are inside the desktop app for these flows.
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  localStorage.clear()
})

describe('EnhanceControls (Stage 05)', () => {
  it('is idle without a job and enables the button when the engine is ready', () => {
    renderHarness(readyStatus)
    expect(screen.getByRole('button', { name: /enhance 4×/i })).toBeEnabled()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('warns and disables when the model is missing', () => {
    renderHarness(missingStatus)
    expect(screen.getByRole('button', { name: /enhance 4×/i })).toBeDisabled()
    expect(screen.getByText(/ai model not installed/i)).toBeInTheDocument()
  })

  it('runs a full job: native events drive the panel, result lands in state', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /enhance 4×/i }))

    // Preparing shows immediately (optimistically via enhance/start).
    expect(await screen.findByText(/preparing image…/i)).toBeInTheDocument()
    // Tile counts are displayed as measured, not faked.
    expect(await screen.findByText(/tile 3 of 3/i)).toBeInTheDocument()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    // Completion: honest done note + success notification with the device.
    expect(await screen.findByText(/result is in the compare view/i)).toBeInTheDocument()
    expect(await screen.findByText(/enhanced to 400 × 300 on directml gpu/i)).toBeInTheDocument()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('enhance_image', expect.anything()))
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
})
