/**
 * Import workflow tests: the Enhance view renders the collection it is
 * given, and useImport funnels native outcomes (the same call a drag &
 * drop or picker session makes) into app state with honest per-file
 * feedback. Stage 04: a populated collection shows the thumbnail rail
 * plus the image workspace for the selected image.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportOutcomeDto, ImportedImageDto } from '../types/ipc'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  Channel: class {
    onmessage: unknown = null
  },
}))

import { EnhanceView } from '../views/EnhanceView'
import { AppStateProvider } from '../state/AppState'
import { NotificationProvider } from '../ui/Notifications'
import { useAppState } from '../state/useAppState'
import { useImport, type ImportApi } from '../state/useImport'
import type { EnhanceApi } from '../state/useEnhance'

/** Stage 05/06: the view renders the enhance controls strip too; idle in
 * jsdom (not the Tauri runtime), so a stub api keeps tests focused. */
const enhanceApi: EnhanceApi = {
  run: async () => {},
  cancel: async () => {},
  dismiss: () => {},
}

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

  // The view reads selection from app state (Stage 04) — render in the
  // provider like the real shell does.
  function renderView(props: {
    importApi: ImportApi
    enhanceApi: EnhanceApi
    images: ImportedImageDto[]
  }) {
    return render(
      <AppStateProvider>
        <EnhanceView {...props} />
      </AppStateProvider>,
    )
  }

  it('shows the drop-zone empty state when the collection is empty', () => {
    renderView({ importApi: api, enhanceApi, images: [] })
    expect(screen.getByRole('heading', { name: /drop an image anywhere/i })).toBeInTheDocument()
    // jsdom is not the Tauri runtime: the picker is honestly disabled.
    expect(screen.getByRole('button', { name: /choose files/i })).toBeDisabled()
  })

  it('renders the thumbnail rail and the workspace for a populated collection', () => {
    const images = [
      importedImage({ id: 'a' }),
      importedImage({ id: 'b', name: 'beach.jpg', format: 'JPEG', width: 4032, height: 3024 }),
    ]
    renderView({ importApi: api, enhanceApi, images })
    expect(screen.getByRole('list', { name: 'Imported images' })).toBeInTheDocument()
    // First image is selected by default; its verified metadata shows.
    expect(screen.getByRole('region', { name: /image workspace — a\.png/i })).toBeInTheDocument()
    expect(screen.getByText('1,920 × 1,080 · PNG · 2.3 MB')).toBeInTheDocument()
    // The viewer toolbar is the natural place for the next action.
    expect(screen.getByRole('toolbar', { name: 'Viewer controls' })).toBeInTheDocument()
  })

  it('switches the workspace to the clicked thumbnail', () => {
    const images = [importedImage({ id: 'a' }), importedImage({ id: 'b', name: 'beach.jpg' })]
    renderView({ importApi: api, enhanceApi, images })
    fireEvent.click(screen.getByTitle('beach.jpg'))
    expect(
      screen.getByRole('region', { name: /image workspace — beach\.jpg/i }),
    ).toBeInTheDocument()
  })

  it('remove buttons call through to the import api', () => {
    const removeImage = vi.fn()
    const images = [importedImage({ id: 'a' })]
    renderView({ importApi: { ...api, removeImage }, enhanceApi, images })
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
        <EnhanceView importApi={api} enhanceApi={enhanceApi} images={state.images} />
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
    // The workspace switched to the collection view showing the image.
    await waitFor(() =>
      expect(screen.getByRole('region', { name: /image workspace — a\.png/i })).toBeInTheDocument(),
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
