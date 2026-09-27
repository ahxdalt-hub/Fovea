/**
 * BatchView (Stage 08/09) rendering: the queue reflects the app-state
 * snapshot exactly — per-item states, measured progress, the completed
 * output line, the failed error, and the cancel/retry affordances — and
 * an empty collection routes the user to import rather than showing a
 * phantom table. The batch api is a stub; the reducer's job (state
 * correctness) is proven in appReducer.test, this proves the view maps
 * state to honest UI.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { BatchItemDto } from '../types/ipc'
import { AppStateProvider } from '../state/AppState'
import { useAppState } from '../state/useAppState'
import { NotificationProvider } from '../ui/Notifications'
import { BatchView } from './BatchView'
import type { BatchApi } from '../state/useBatch'

vi.mock('../ipc/bridge', () => ({
  pickExportFolder: vi.fn(() => Promise.resolve('')),
}))

function item(overrides: Partial<BatchItemDto> & { id: string }): BatchItemDto {
  return {
    imageId: `C:/${overrides.id}.png`,
    name: `${overrides.id}.png`,
    state: 'waiting',
    done: 0,
    total: 0,
    device: null,
    error: null,
    output: null,
    mode: 'standard',
    scale: 2,
    cancelling: false,
    ...overrides,
  }
}

function mockApi(running: boolean, extra: Partial<BatchApi> = {}): BatchApi {
  return {
    running,
    start: vi.fn(async () => {}),
    cancelItem: vi.fn(async () => {}),
    cancelAll: vi.fn(async () => {}),
    retryFailed: vi.fn(async () => {}),
    dismiss: vi.fn(),
    refresh: vi.fn(async () => {}),
    ...extra,
  }
}

function Seed({ items, running }: { items: BatchItemDto[]; running: boolean }) {
  const { dispatch, state } = useAppState()
  useEffect(() => {
    if (state.batch === null)
      dispatch({ type: 'batch/snapshot', snapshot: { items, running, workerLimit: 1 } })
  }, [dispatch, state.batch, items, running])
  return null
}

function renderBatch(items: BatchItemDto[], running: boolean, api = mockApi(running)) {
  return render(
    <AppStateProvider>
      <NotificationProvider>
        <Seed items={items} running={running} />
        <BatchView batchApi={api} onGoToEnhance={() => {}} />
      </NotificationProvider>
    </AppStateProvider>,
  )
}

describe('BatchView', () => {
  it('shows an honest empty state when there is no collection and no batch', () => {
    render(
      <AppStateProvider>
        <NotificationProvider>
          <BatchView batchApi={mockApi(false)} onGoToEnhance={() => {}} />
        </NotificationProvider>
      </AppStateProvider>,
    )
    expect(screen.getByRole('heading', { name: 'Batch' })).toBeInTheDocument()
    expect(screen.getByText(/nothing to batch yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /import images/i })).toBeInTheDocument()
  })

  it('renders the queue with per-item states', () => {
    renderBatch(
      [
        item({
          id: 'a',
          state: 'completed',
          total: 4,
          done: 4,
          output: {
            filePath: 'C:/out/a.png',
            fileName: 'a.png',
            folder: 'C:/out',
            bytes: 10,
            sourceWidth: 100,
            sourceHeight: 80,
            outputWidth: 400,
            outputHeight: 320,
            label: '4× · Standard',
            engine: 'CPU',
          },
        }),
        item({ id: 'b', state: 'processing', total: 8, done: 3, device: 'DirectML GPU' }),
        item({ id: 'c', state: 'failed', error: { code: 'processing_failed', message: 'boom' } }),
        item({ id: 'd', state: 'cancelled' }),
      ],
      true,
    )
    expect(screen.getByText('a.png')).toBeInTheDocument()
    expect(screen.getByText(/Done/)).toBeInTheDocument()
    expect(screen.getByText(/400 × 320/)).toBeInTheDocument()
    expect(screen.getByText(/boom/)).toBeInTheDocument()
    expect(screen.getByText(/^Cancelled$/)).toBeInTheDocument()
    // A live item shows its cancel affordance; the batch shows cancel-all.
    expect(screen.getByRole('button', { name: /cancel b.png/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /cancel all/i })).toBeInTheDocument()
  })

  it('offers retry only once the batch has settled with a failure', () => {
    const api = mockApi(false)
    renderBatch(
      [item({ id: 'a', state: 'completed' }), item({ id: 'b', state: 'failed' })],
      false,
      api,
    )
    const retry = screen.getByRole('button', { name: /retry failed/i })
    fireEvent.click(retry)
    expect(api.retryFailed).toHaveBeenCalled()
  })

  it('dismisses a settled queue', () => {
    const api = mockApi(false)
    renderBatch([item({ id: 'a', state: 'completed' })], false, api)
    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }))
    expect(api.dismiss).toHaveBeenCalled()
  })
})
