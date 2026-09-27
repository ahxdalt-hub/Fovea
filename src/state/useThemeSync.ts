import { useEffect } from 'react'
import { useAppState } from './useAppState'

/**
 * Apply the theme preference to the document root.
 *
 * The preference lives in persisted settings (Stage 10); `system` stores
 * no attribute so the prefers-color-scheme block in tokens.css takes over;
 * explicit choices set [data-theme] directly. The title-bar background
 * follows the theme via a documented mechanism: later stages will call the
 * Tauri window theme API here if desired.
 */
export function useThemeSync() {
  const { state } = useAppState()
  const theme = state.settings.general.theme

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])
}
