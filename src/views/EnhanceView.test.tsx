/**
 * Import workflow tests: the Enhance view renders the collection it is
 * given, and useImport funnels native outcomes (the same call a drag &
 * drop or picker session makes) into app state with honest per-file
 * feedback.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportOutcomeDto, ImportedImageDto } from '../types/ipc'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}))

import { EnhanceView } from '../views/EnhanceView'
import { AppStateProvider } from '../state/AppState'
import { NotificationProvider } from '../ui/Notifications'
import { useAppState } from '../state/useAppState'
import { useImport, type ImportApi } from '../state/useImport'

function importedImage(overrides: Partial<ImportedImageDto> & { id: string }): ImportedImageDto {
  return {
    name: `${overrides.id}.png`,
    format: 'PNG',
    width: 1920,
    height: 1080,
    sizeBytes: 2_400_000,
    previewDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    ...overrides,
  }
}

describe('EnhanceView collection', () => {
  const noop = async () => {}
  const api: ImportApi = {
    importing: false,
    browse: noop,
    dropPaths: noop,
    removeImage: vi.fn(),
    clearImages: vi.fn(),
  }

  it('shows the drop-zone empty state when the collection is empty', () => {
    render(<EnhanceView importApi={api} images={[]} />)
    expect(screen.getByRole('heading', { name: /drop an image anywhere/i })).toBeInTheDocument()
    // jsdom is not the Tauri runtime: the picker is honestly disabled.
    expect(screen.getByRole('button', { name: /choose files/i })).toBeDisabled()
  })

  it('renders thumbnails and the inspector for a populated collection', () => {
    const images = [
      importedImage({ id: 'a' }),
      importedImage({ id: 'b', name: 'beach.jpg', format: 'JPEG', width: 4032, height: 3024 }),
    ]
    render(<EnhanceView importApi={api} images={images} />)
    expect(screen.getByRole('list', { name: 'Imported images' })).toBeInTheDocument()
    // First image is selected by default; its verified metadata shows.
    expect(screen.getByRole('heading', { level: 3, name: 'a.png' })).toBeInTheDocument()
    expect(screen.getByText(/1,920 × 1,080/)).toBeInTheDocument()
    expect(screen.getByText(/2\.3 MB/)).toBeInTheDocument()
    expect(screen.getByText('Ready')).toBeInTheDocument()
  })

  it('switches the inspector to the clicked thumbnail', () => {
    const images = [importedImage({ id: 'a' }), importedImage({ id: 'b', name: 'beach.jpg' })]
    render(<EnhanceView importApi={api} images={images} />)
    fireEvent.click(screen.getByTitle('beach.jpg'))
    expect(screen.getByRole('heading', { level: 3, name: 'beach.jpg' })).toBeInTheDocument()
  })

  it('remove buttons call through to the import api', () => {
    const removeImage = vi.fn()
    const images = [importedImage({ id: 'a' })]
    render(<EnhanceView importApi={{ ...api, removeImage }} images={images} />)
    fireEvent.click(screen.getByRole('button', { name: /remove a\.png/i }))
    expect(removeImage).toHaveBeenCalledWith('a')
  })
})

describe('useImport funnel', () => {
  const config = {
    productName: 'Pixora',
    version: '0.3.0',
    identifier: 'com.pixora.desktop',
    debug: true,
  }
  const systemInfo = { osFamily: 'windows', arch: 'x86_64', appDataDir: 'C:/x' }

  beforeEach(() => {
    invoke.mockReset()
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'get_config') return Promise.resolve(config)
      if (cmd === 'get_system_info') return Promise.resolve(systemInfo)
      return Promise.resolve(null)
    })
    localStorage.clear()
  })

  /** Harness stands in for the shell: it renders the real view and the
   * real hook, then exposes a button that behaves like a native drop.
   * Hooks run *inside* the providers, exactly like in App.tsx. */
  function Harness({ paths }: { paths: string[] }) {
    return (
      <AppStateProvider>
        <NotificationProvider>
          <HarnessInner paths={paths} />
        </NotificationProvider>
      </AppStateProvider>
    )
  }
  function HarnessInner({ paths }: { paths: string[] }) {
    const api = useImport()
    const { state } = useAppState()
    return (
      <>
        <button type="button" onClick={() => void api.dropPaths(paths)}>
          simulate drop
        </button>
        <EnhanceView importApi={api} images={state.images} />
      </>
    )
  }

  it('imports good files, notifies per-file failures, switches to the collection', async () => {
    const outcomes: ImportOutcomeDto[] = [
      { status: 'imported', image: importedImage({ id: 'a' }) },
      {
        status: 'failed',
        name: 'notes.txt',
        error: { code: 'unsupported_format', message: 'This file type isn’t supported yet.' },
      },
    ]
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'import_images') return Promise.resolve(outcomes)
      if (cmd === 'get_config') return Promise.resolve(config)
      if (cmd === 'get_system_info') return Promise.resolve(systemInfo)
      return Promise.resolve(null)
    })

    render(<Harness paths={['C:\\a.png', 'C:\\notes.txt']} />)
    fireEvent.click(screen.getByRole('button', { name: 'simulate drop' }))

    // Success and per-file failure are both reported as notifications.
    expect(await screen.findByText(/imported 1 image/i)).toBeInTheDocument()
    expect(screen.getByText(/notes\.txt — this file type/i)).toBeInTheDocument()
    // The workspace switched to the collection view.
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 3, name: 'a.png' })).toBeInTheDocument(),
    )
  })

  it('tells the user when a duplicate selection added nothing new', async () => {
    const outcome: ImportOutcomeDto = { status: 'imported', image: importedImage({ id: 'a' }) }
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'import_images') return Promise.resolve([outcome])
      if (cmd === 'get_config') return Promise.resolve(config)
      if (cmd === 'get_system_info') return Promise.resolve(systemInfo)
      return Promise.resolve(null)
    })

    render(<Harness paths={['C:\\a.png']} />)
    fireEvent.click(screen.getByRole('button', { name: 'simulate drop' }))
    await screen.findByText(/imported 1 image/i)

    fireEvent.click(screen.getByRole('button', { name: 'simulate drop' }))
    expect(await screen.findByText(/already in your workspace/i)).toBeInTheDocument()
  })

  it('surfaces whole-batch failures as an error notification', async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === 'import_images')
        return Promise.reject({ code: 'unexpected_error', message: 'core went away' })
      if (cmd === 'get_config') return Promise.resolve(config)
      if (cmd === 'get_system_info') return Promise.resolve(systemInfo)
      return Promise.resolve(null)
    })

    render(<Harness paths={['C:\\a.png']} />)
    fireEvent.click(screen.getByRole('button', { name: 'simulate drop' }))
    expect(await screen.findByText('core went away')).toBeInTheDocument()
  })
})
