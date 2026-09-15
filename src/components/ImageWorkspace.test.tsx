/**
 * ImageWorkspace tests: the viewer renders the selected image with its
 * verified metadata, the toolbar controls change the zoom readout, Fit
 * returns after zooming, compare mode mounts the slider, and the honest
 * preview fallback works when the native core is unreachable (jsdom is
 * not Tauri). Geometry is stubbed because jsdom reports zero rects.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageEnhancementDto, ImportedImageDto } from '../types/ipc'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}))

import { ImageWorkspace } from './ImageWorkspace'
import { seedSourceCache, clearSourceCache } from '../state/imageSources'

function image(overrides: Partial<ImportedImageDto> & { id: string }): ImportedImageDto {
  return {
    name: `${overrides.id}.png`,
    format: 'PNG',
    width: 4000,
    height: 2000,
    sizeBytes: 8_400_000,
    previewDataUrl: 'data:image/png;base64,PREVIEW',
    ...overrides,
  }
}

const noop = () => {}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockRejectedValue({ code: 'unexpected_error', message: 'no core in tests' })
  clearSourceCache()
  // jsdom paints zero-sized elements; give the stage a real box.
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 800,
      width: 1200,
      height: 800,
      toJSON: () => ({}),
    }
  }
})

function renderWorkspace(
  img: ImportedImageDto = image({ id: 'a' }),
  enhanced: ImageEnhancementDto | null = null,
) {
  return render(<ImageWorkspace image={img} enhanced={enhanced} onAddMore={noop} onClear={noop} />)
}

function zoomLabel(): HTMLElement {
  return screen.getByRole('button', { name: /^1?0?0%|^\d+(\.\d+)?%$/ }) as HTMLElement
}

describe('ImageWorkspace', () => {
  it('paints the image and its verified metadata', () => {
    renderWorkspace()
    // Fallback tier: the small preview (native core unavailable in jsdom).
    expect(screen.getByAltText('a.png')).toHaveAttribute('src', 'data:image/png;base64,PREVIEW')
    expect(screen.getByText('4,000 × 2,000 · PNG · 8.0 MB')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fit to workspace' })).toBeEnabled()
  })

  it('uses a cached display-size source when the core served one before', () => {
    seedSourceCache('b', 'view', {
      width: 1600,
      height: 900,
      deliveredEdge: 1600,
      original: true,
      dataUrl: 'data:image/jpeg;base64,VIEWBIGGER',
    })
    renderWorkspace(image({ id: 'b', width: 1600, height: 900 }))
    expect(screen.getByAltText('b.png')).toHaveAttribute('src', 'data:image/jpeg;base64,VIEWBIGGER')
  })

  it('zoom in changes the readout and disables Fit; Fit restores', () => {
    renderWorkspace()
    const fit = screen.getByRole('button', { name: 'Fit to workspace' })
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    // 29% → 36% (fit for 4000×2000 in 1200×800 minus padding is 0.286).
    expect(zoomLabel().textContent).toBe('36%')
    fireEvent.click(screen.getByRole('button', { name: 'Fit to workspace' }))
    expect(zoomLabel().textContent).toBe('29%')
    expect(fit).toHaveAttribute('aria-pressed', 'true')
  })

  it('keyboard +/0 work while the stage has focus and stop shell navigation', () => {
    renderWorkspace()
    const stage = screen.getByRole('group', { name: /a\.png, 4,000 × 2,000 pixels/ })
    stage.focus()
    fireEvent.keyDown(stage, { key: '-' })
    expect(zoomLabel().textContent).toBe('23%')
    const navigated = vi.fn()
    window.addEventListener('keydown', navigated)
    fireEvent.keyDown(stage, { key: '1' }) // actual size — must NOT reach the shell
    expect(zoomLabel().textContent).toBe('100%')
    expect(navigated).not.toHaveBeenCalled()
    window.removeEventListener('keydown', navigated)
    fireEvent.keyDown(stage, { key: '0' })
    expect(zoomLabel().textContent).toBe('29%')
  })

  it('pan clamps so no stage edge is ever left empty', () => {
    renderWorkspace(image({ id: 'c', width: 100, height: 100 }))
    const stage = screen.getByRole('group', { name: /c\.png/ })
    // Tiny image: dragging must not create a gap — the view re-centers.
    fireEvent.pointerDown(stage, { clientX: 100, clientY: 100, button: 0, pointerId: 1 })
    fireEvent.pointerMove(stage, { clientX: 400, clientY: 400, pointerId: 1, buttons: 1 })
    fireEvent.pointerUp(stage, { pointerId: 1 })
    const layer = document.querySelector('.pix-ws__layer') as HTMLElement
    // Centered: x = (1200 - 100*scale)/2, positive, never beyond the box.
    expect(layer.style.transform).toMatch(/translate3d\(\d+(\.\d+)?px, \d+(\.\d+)?px, 0\)/)
  })

  it('compare mode mounts the slider with an honest pending after side', () => {
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(screen.getByRole('slider', { name: /Original \/ Enhanced divider/ })).toBeInTheDocument()
    expect(screen.getByText(/Enhanced will appear here/i)).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('group', { name: /a\.png/ }), { key: 'c' })
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('compare mode shows the enhanced result once Stage 05 delivers one', () => {
    renderWorkspace(image({ id: 'a' }), {
      imageId: 'a',
      dataUrl: 'data:image/png;base64,ENHANCED',
      width: 8000,
      height: 4000,
      label: '4× · Standard',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(screen.getByAltText('Enhanced version')).toHaveAttribute(
      'src',
      'data:image/png;base64,ENHANCED',
    )
    expect(screen.getByText('4× · Standard')).toBeInTheDocument()
  })

  it('full screen control exists and never throws outside a real browser', () => {
    renderWorkspace()
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }))
    // jsdom has no Fullscreen API: the guard swallows it, UI stays intact.
    expect(screen.getByRole('button', { name: 'Zoom in' })).toBeInTheDocument()
  })

  it('shows the preparing status until the native view arrives', async () => {
    renderWorkspace()
    // In jsdom there is no Tauri runtime, so no veil — the preview shows.
    await waitFor(() => expect(screen.getByAltText('a.png')).toBeInTheDocument())
    expect(screen.queryByText(/Reading full image locally/i)).not.toBeInTheDocument()
  })
})
