/**
 * Menu: trigger semantics, keyboard open/select/close, focus return, and
 * outside-click dismissal.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Menu, type MenuItem } from './Menu'

function renderMenu() {
  const onSelect = vi.fn()
  const items: MenuItem[] = [
    { id: 'a', label: 'Alpha', onSelect },
    { id: 'b', label: 'Beta', onSelect },
    { id: 'c', label: 'Gamma', disabled: true, onSelect },
  ]
  render(<Menu label="Test menu" trigger={<span>T</span>} items={items} />)
  return onSelect
}

describe('Menu', () => {
  it('renders a labelled trigger with popup semantics and no open menu', () => {
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Test menu' })
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens on Enter, focuses the first item, and arrow-walks skipping disabled', () => {
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Test menu' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    expect(screen.getByRole('menu')).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    const [alpha, beta] = screen.getAllByRole('menuitem')
    expect(document.activeElement).toBe(alpha)

    fireEvent.keyDown(alpha!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(beta)

    fireEvent.keyDown(beta!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(alpha) // wraps; skips disabled Gamma

    fireEvent.keyDown(alpha!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(beta) // wraps backwards

    fireEvent.keyDown(beta!, { key: 'End' })
    expect(document.activeElement).toBe(beta) // last enabled item
  })

  it('selects with Enter, calls the handler, closes, and returns focus to the trigger', () => {
    const onSelect = renderMenu()
    const trigger = screen.getByRole('button', { name: 'Test menu' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    const [, beta] = screen.getAllByRole('menuitem')
    fireEvent.click(beta!)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on Escape and on outside pointerdown', () => {
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Test menu' })
    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(trigger)

    fireEvent.keyDown(trigger, { key: 'Enter' })
    fireEvent.pointerDown(document.body, { bubbles: true })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('does not open disabled items', () => {
    renderMenu()
    const trigger = screen.getByRole('button', { name: 'Test menu' })
    fireEvent.click(trigger)
    const gamma = screen.getByRole('menuitem', { name: 'Gamma' })
    expect(gamma).toBeDisabled()
    fireEvent.click(gamma)
    expect(screen.getByRole('menu')).toBeInTheDocument() // still open: click ignored
  })
})
