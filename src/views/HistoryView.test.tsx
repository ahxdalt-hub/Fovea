/**
 * HistoryView (Stage 09) rendering: a real journal read maps to honest
 * rows — completed runs show measured dimensions and their saved
 * location, failed runs show the user-safe error, and a source that has
 * since moved or been deleted is flagged and its reopen action disabled
 * (the row stays as history rather than offering a click that would
 * fail). The bridge is stubbed; the native store's own correctness is
 * proven in `services::history`.
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntryDto } from '../types/ipc'
import { NotificationProvider } from '../ui/Notifications'
import { AppStateProvider } from '../state/AppState'
import { HistoryView } from './HistoryView'

const getHistory = vi.fn()
const clearHistory = vi.fn()
vi.mock('../ipc/bridge', () => ({
  getHistory: () => getHistory(),
  clearHistory: () => clearHistory(),
}))

// Reopening a source needs the native import path, so the Open affordance
// is only offered inside the desktop runtime. Pretend we're there.
vi.mock('../state/useNativeFileDrop', () => ({
  isTauriRuntime: () => true,
}))

function entry(overrides: Partial<HistoryEntryDto> & { id: string }): HistoryEntryDto {
  return {
    sourcePath: `C:/pics/${overrides.id}.png`,
    fileName: `${overrides.id}.png`,
    originalWidth: 1000,
    originalHeight: 800,
    outputWidth: 4000,
    outputHeight: 3200,
    scale: 4,
    mode: 'standard',
    status: 'completed',
    errorMessage: null,
    createdAt: 1_700_000_000_000,
    kind: 'single',
    outputPath: `C:/out/${overrides.id}.png`,
    sourceExists: true,
    outputExists: true,
    ...overrides,
  }
}

function renderHistory(onReopen = vi.fn()) {
  render(
    <NotificationProvider>
      <AppStateProvider>
        <HistoryView onGoToEnhance={() => {}} onReopen={onReopen} />
      </AppStateProvider>
    </NotificationProvider>,
  )
  return onReopen
}

beforeEach(() => {
  getHistory.mockReset()
  clearHistory.mockReset()
})

describe('HistoryView', () => {
  it('shows an empty state with a route to Enhance when the journal is empty', async () => {
    getHistory.mockResolvedValue({ entries: [], recents: [] })
    renderHistory()
    expect(await screen.findByRole('button', { name: /open enhance/i })).toBeInTheDocument()
    expect(screen.getByText(/no enhancements yet/i)).toBeInTheDocument()
  })

  it('renders completed rows with measured dimensions and the saved location', async () => {
    getHistory.mockResolvedValue({ entries: [entry({ id: 'sunset' })], recents: [] })
    renderHistory()
    expect(await screen.findByText('sunset.png')).toBeInTheDocument()
    expect(screen.getByText(/4× · Standard/)).toBeInTheDocument()
    // 1000×800 → 4000×3200 (formatDimensions localizes with separators).
    expect(screen.getByText(/4,000 × 3,200/)).toBeInTheDocument()
    expect(screen.getByText(/C:\/out\/sunset.png/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^open$/i })).toBeInTheDocument()
  })

  it('shows the user-safe error for a failed run', async () => {
    getHistory.mockResolvedValue({
      entries: [
        entry({
          id: 'broken',
          status: 'failed',
          errorMessage: 'Processing failed. Try again.',
          originalWidth: 0,
          originalHeight: 0,
          outputWidth: 0,
          outputHeight: 0,
          outputPath: null,
        }),
      ],
      recents: [],
    })
    renderHistory()
    expect(await screen.findByText('broken.png')).toBeInTheDocument()
    expect(screen.getByText(/Processing failed. Try again./)).toBeInTheDocument()
    expect(screen.getByText('no output')).toBeInTheDocument()
  })

  it('flags a missing source and disables its reopen action', async () => {
    getHistory.mockResolvedValue({
      entries: [entry({ id: 'gone', sourceExists: false, outputExists: false })],
      recents: [],
    })
    const onReopen = renderHistory()
    expect(await screen.findByText('gone.png')).toBeInTheDocument()
    expect(screen.getByText(/file moved or deleted/i)).toBeInTheDocument()
    // No Open button is offered for a dead pointer — and clicking nothing.
    expect(screen.queryByRole('button', { name: /^open$/i })).not.toBeInTheDocument()
    expect(onReopen).not.toHaveBeenCalled()
  })

  it('reopens a present source through the onReopen callback', async () => {
    getHistory.mockResolvedValue({ entries: [entry({ id: 'good' })], recents: [] })
    const onReopen = renderHistory()
    await screen.findByText('good.png')
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }))
    await waitFor(() => expect(onReopen).toHaveBeenCalledWith('C:/pics/good.png'))
  })

  it('clears history through the native command, not by inventing state', async () => {
    getHistory.mockResolvedValue({ entries: [entry({ id: 'a' })], recents: [] })
    clearHistory.mockResolvedValue(null)
    renderHistory()
    await screen.findByText('a.png')
    // Open the confirmation from the header button.
    fireEvent.click(screen.getByRole('button', { name: /clear history/i }))
    const dialog = await screen.findByRole('dialog', { name: /clear history/i })
    fireEvent.click(within(dialog).getByRole('button', { name: /^clear history$/i }))
    await waitFor(() => expect(clearHistory).toHaveBeenCalled())
  })
})
