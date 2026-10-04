/**
 * Shell keyboard shortcuts.
 *
 * Global, non-conflicting keys only. Ignored while typing in inputs or
 * when a modal owns the keyboard: any open `role="dialog"` suppresses the
 * shell's keys, so a dialog that lives in a view's local state (the export
 * dialog) can't have the workspace navigate underneath it. New shortcuts
 * must be added to the ShortcutsDialog list as well.
 */
import { useEffect, useRef } from 'react'
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

/** A modal is up. Dialogs render exactly one of these while open. */
function modalIsOpen(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') !== null
}

export interface ShortcutHandlers {
  enabled: boolean
  onNavigate: (view: ViewId) => void
  onOpenSettings: () => void
  onToggleShortcuts: () => void
  /** Ctrl+O — open the native import dialog. */
  onOpenImport: () => void
}

export function useKeyboardShortcuts({
  enabled,
  onNavigate,
  onOpenSettings,
  onToggleShortcuts,
  onOpenImport,
}: ShortcutHandlers) {
  // Latest-value ref (the codebase's idiom): the listener subscribes once
  // instead of being torn down and re-added on every shell render, which
  // happens on each progress event while a job runs.
  const handlers = useRef({ onNavigate, onOpenSettings, onToggleShortcuts, onOpenImport })
  useEffect(() => {
    handlers.current = { onNavigate, onOpenSettings, onToggleShortcuts, onOpenImport }
  })

  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent) {
      if (isTypingTarget(event.target) || modalIsOpen()) return
      if (event.key === 'F1') {
        event.preventDefault()
        handlers.current.onToggleShortcuts()
        return
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === ',') {
        event.preventDefault()
        handlers.current.onOpenSettings()
        return
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        handlers.current.onOpenImport()
        return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === '1') handlers.current.onNavigate('enhance')
      else if (event.key === '2') handlers.current.onNavigate('batch')
      else if (event.key === '3') handlers.current.onNavigate('history')
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
