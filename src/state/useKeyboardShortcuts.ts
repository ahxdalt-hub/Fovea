/**
 * Shell keyboard shortcuts.
 *
 * Global, non-conflicting keys only. Ignored while typing in inputs or
 * when a modal owns the keyboard (the Dialog handles its own Esc).
 * `enabled` lets the shell suspend navigation while a dialog is open so
 * the workspace can't change underneath a modal.
 * New shortcuts must be added to the ShortcutsDialog list as well.
 */
import { useEffect } from 'react'
import type { ViewId } from './appReducer'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  )
}

export interface ShortcutHandlers {
  enabled: boolean
  onNavigate: (view: ViewId) => void
  onOpenSettings: () => void
  onToggleShortcuts: () => void
}

export function useKeyboardShortcuts({
  enabled,
  onNavigate,
  onOpenSettings,
  onToggleShortcuts,
}: ShortcutHandlers) {
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return
      if (event.key === 'F1') {
        event.preventDefault()
        onToggleShortcuts()
        return
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === ',') {
        event.preventDefault()
        onOpenSettings()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === '1') onNavigate('enhance')
      else if (event.key === '2') onNavigate('batch')
      else if (event.key === '3') onNavigate('history')
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, onNavigate, onOpenSettings, onToggleShortcuts])
}
