/**
 * The compare slider is one of Pixora's signature experiences — these
 * tests pin its interaction contract (drag, keyboard, labels) and its
 * honest pending state when no enhanced result exists yet.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CompareSplit } from './CompareSplit'

function stubRect(el: HTMLElement) {
  el.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 300,
    width: 400,
    height: 300,
    toJSON: () => ({}),
  })
}

const before = 'data:image/png;base64,YmVmb3Jl'
const after = 'data:image/png;base64,YWZ0ZXI='

describe('CompareSplit', () => {
  it('renders both sides and a slider handle when an enhanced result exists', () => {
    render(<CompareSplit beforeSrc={before} afterSrc={after} width={800} height={600} />)
    expect(screen.getByRole('slider', { name: /Original \/ Enhanced divider/ })).toBeInTheDocument()
    expect(screen.getByAltText('Original version')).toBeInTheDocument()
    expect(screen.getByAltText('Enhanced version')).toBeInTheDocument()
  })

  it('shows an honest pending panel — not a fake image — when after is null', () => {
    render(<CompareSplit beforeSrc={before} afterSrc={null} width={800} height={600} />)
    expect(screen.getByText(/Enhanced will appear here/i)).toBeInTheDocument()
    expect(screen.queryByAltText('Enhanced version')).not.toBeInTheDocument()
    // The slider still works: the interaction is proven before results exist.
    expect(screen.getByRole('slider')).toBeInTheDocument()
  })

  it('moves with keyboard arrows and announces position', () => {
    render(<CompareSplit beforeSrc={before} afterSrc={after} width={800} height={600} />)
    const slider = screen.getByRole('slider')
    expect(slider).toHaveAttribute('aria-valuenow', '50')
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(slider).toHaveAttribute('aria-valuenow', '52')
    fireEvent.keyDown(slider, { key: 'ArrowLeft', shiftKey: true })
    fireEvent.keyDown(slider, { key: 'ArrowLeft', shiftKey: true })
    expect(slider).toHaveAttribute('aria-valuenow', '32')
    fireEvent.keyDown(slider, { key: 'Home' })
    expect(Number(slider.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(4)
  })

  it('follows the pointer while dragging', () => {
    render(<CompareSplit beforeSrc={before} afterSrc={after} width={800} height={600} />)
    const root = document.querySelector('.pix-compare') as HTMLElement
    stubRect(root)
    const slider = screen.getByRole('slider')
    fireEvent.pointerDown(slider, { clientX: 200, pointerId: 1 }) // center
    fireEvent.pointerMove(slider, { clientX: 360, pointerId: 1, buttons: 1 }) // 90%
    expect(slider).toHaveAttribute('aria-valuenow', '90')
    // Clamped to keep both sides visible.
    fireEvent.pointerMove(slider, { clientX: 900, pointerId: 1, buttons: 1 })
    expect(Number(slider.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(97)
  })

  it('marks demo fixtures so review is never fooled', () => {
    render(<CompareSplit beforeSrc={before} afterSrc={after} width={800} height={600} demoBadge />)
    expect(screen.getByText('demo')).toBeInTheDocument()
  })
})
