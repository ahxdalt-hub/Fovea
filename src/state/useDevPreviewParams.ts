/**
 * Dev-only URL preview parameters.
 *
 * When running the Vite dev server in a plain browser, `?theme=dark`,
 * `?view=batch|history` and `?dialog=settings|shortcuts|about` can pin the
 * shell's initial state. This exists so visual QA (screenshots of every
 * state) can run headlessly without synthetic clicks. It is inert inside
 * Tauri (no such URL), inert in tests, and stripped from release builds —
 * Vite replaces import.meta.env.DEV with false.
 */
import { useEffect } from 'react'
import type { AppAction, ThemePreference, ViewId } from './appReducer'
import { useAppState } from './useAppState'

export function useDevPreviewParams() {
  const { dispatch } = useAppState()

  useEffect(() => {
    if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return
    if ('__TAURI_INTERNALS__' in window) return
    const params = new URLSearchParams(window.location.search)

    const theme = params.get('theme')
    if (theme === 'light' || theme === 'dark' || theme === 'system') {
      const action: AppAction = { type: 'ui/setTheme', theme: theme as ThemePreference }
      dispatch(action)
    }
    const view = params.get('view')
    if (view === 'enhance' || view === 'batch' || view === 'history') {
      dispatch({ type: 'ui/navigate', view: view as ViewId })
    }
    const dialog = params.get('dialog')
    if (dialog === 'settings') dispatch({ type: 'ui/settings', open: true })
  }, [dispatch])
}
