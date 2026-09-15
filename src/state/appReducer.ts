/**
 * Application state — types and pure reducer.
 *
 * Stage 01 deliberately avoids a state library: one context + reducer is
 * enough for startup status and shell UI state. The shape here (typed
 * actions, single pure reducer) is what later feature stores will follow.
 */
import type { AppConfigDto, AppErrorPayload, ImportedImageDto, SystemInfoDto } from '../types/ipc'

/** Native connection lifecycle. */
export type CoreStatus = 'connecting' | 'ready' | 'error'

/** Primary navigation destinations in the shell. */
export type ViewId = 'enhance' | 'batch' | 'history'

/** Theme preference; `system` follows the OS and stores no attribute. */
export type ThemePreference = 'system' | 'light' | 'dark'

export interface UiState {
  view: ViewId
  theme: ThemePreference
  /** Settings dialog open state lives in the shell so the nav rail can
   * reflect it and Esc/backdrop can close it from one place. */
  settingsOpen: boolean
}

export interface AppState {
  coreStatus: CoreStatus
  config: AppConfigDto | null
  systemInfo: SystemInfoDto | null
  /** Last error surfaced from the native layer, already user-safe. */
  error: AppErrorPayload | null
  /**
   * The imported-image collection (Stage 03 foundation). Ordered by
   * first import; deduplicated by canonical path id. Stage 08's batch
   * queue consumes this list.
   */
  images: ImportedImageDto[]
  /** An import batch is in flight (native validation running). */
  importing: boolean
  ui: UiState
}

export type AppAction =
  | { type: 'core/connecting' }
  | { type: 'core/ready'; config: AppConfigDto; systemInfo: SystemInfoDto }
  | { type: 'core/error'; error: AppErrorPayload }
  | { type: 'ui/navigate'; view: ViewId }
  | { type: 'ui/setTheme'; theme: ThemePreference }
  | { type: 'ui/retryCore' }
  | { type: 'ui/settings'; open: boolean }
  | { type: 'import/start' }
  | { type: 'import/end' }
  | { type: 'images/add'; images: ImportedImageDto[] }
  | { type: 'images/remove'; id: string }
  | { type: 'images/clear' }

export const initialState: AppState = {
  coreStatus: 'connecting',
  config: null,
  systemInfo: null,
  error: null,
  images: [],
  importing: false,
  ui: {
    view: 'enhance',
    theme: readStoredTheme(),
    settingsOpen: false,
  },
}

const THEME_STORAGE_KEY = 'pixora:theme'

/** Read the persisted theme preference. Safe in non-browser environments. */
export function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Storage unavailable (privacy mode, tests): fall through to default.
  }
  return 'system'
}

export function persistTheme(theme: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // Persisting a visual preference must never break the app.
  }
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'core/connecting':
      return { ...state, coreStatus: 'connecting', error: null }
    case 'core/ready':
      return {
        ...state,
        coreStatus: 'ready',
        config: action.config,
        systemInfo: action.systemInfo,
        error: null,
      }
    case 'core/error':
      return { ...state, coreStatus: 'error', error: action.error }
    case 'ui/navigate':
      return { ...state, ui: { ...state.ui, view: action.view } }
    case 'ui/setTheme':
      return { ...state, ui: { ...state.ui, theme: action.theme } }
    case 'ui/settings':
      return { ...state, ui: { ...state.ui, settingsOpen: action.open } }
    case 'ui/retryCore':
      // Re-enter connecting so the bootstrap effect re-runs.
      return { ...state, coreStatus: 'connecting', error: null }
    case 'import/start':
      return { ...state, importing: true }
    case 'import/end':
      return { ...state, importing: false }
    case 'images/add': {
      // Dedup by canonical id: re-importing a file refreshes nothing —
      // the first import stands. The collection keeps insertion order.
      const known = new Set(state.images.map((img) => img.id))
      const fresh = action.images.filter((img) => !known.has(img.id))
      if (fresh.length === 0) return state
      return { ...state, images: [...state.images, ...fresh] }
    }
    case 'images/remove':
      return { ...state, images: state.images.filter((img) => img.id !== action.id) }
    case 'images/clear':
      return { ...state, images: [] }
  }
}
