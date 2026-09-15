/**
 * Application state — types and pure reducer.
 *
 * Stage 01 deliberately avoids a state library: one context + reducer is
 * enough for startup status and shell UI state. The shape here (typed
 * actions, single pure reducer) is what later feature stores will follow.
 */
import type {
  AppConfigDto,
  AppErrorPayload,
  ImageEnhancementDto,
  ImportedImageDto,
  SystemInfoDto,
} from '../types/ipc'

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
  /**
   * Which imported image the workspace is showing (Stage 04). A stored
   * id that no longer exists falls back to the first image — selection
   * is derived at read time, so it never desyncs from the collection.
   */
  selectedImageId: string | null
  /**
   * Enhanced results keyed by image id. Stage 04 defines the wiring;
   * Stage 05's engine is the first thing to populate it. Empty in
   * production until then — the viewer treats a missing entry as the
   * honest "no result yet" state and never fabricates one.
   */
  enhancements: Record<string, ImageEnhancementDto>
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
  | { type: 'images/select'; id: string | null }
  | { type: 'enhancements/set'; enhancement: ImageEnhancementDto }
  | { type: 'enhancements/clear'; imageId?: string }

export const initialState: AppState = {
  coreStatus: 'connecting',
  config: null,
  systemInfo: null,
  error: null,
  images: [],
  selectedImageId: null,
  enhancements: {},
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
      // The first imported image becomes the workspace selection, so a
      // drop lands on something visible immediately.
      const selectedImageId = state.selectedImageId ?? fresh[0]?.id ?? null
      return { ...state, images: [...state.images, ...fresh], selectedImageId }
    }
    case 'images/remove': {
      const images = state.images.filter((img) => img.id !== action.id)
      const { [action.id]: _gone, ...enhancements } = state.enhancements
      return {
        ...state,
        images,
        enhancements,
        // Dangling selection resets to the first remaining image (or null).
        selectedImageId:
          state.selectedImageId === action.id ? (images[0]?.id ?? null) : state.selectedImageId,
      }
    }
    case 'images/clear':
      return { ...state, images: [], selectedImageId: null, enhancements: {} }
    case 'images/select':
      return { ...state, selectedImageId: action.id }
    case 'enhancements/set':
      // Stage 05's engine dispatches through here; Stage 04 only defines
      // the contract. Keyed by image id so re-running an enhancement
      // replaces the previous result cleanly.
      return {
        ...state,
        enhancements: { ...state.enhancements, [action.enhancement.imageId]: action.enhancement },
      }
    case 'enhancements/clear': {
      if (!action.imageId) return { ...state, enhancements: {} }
      const { [action.imageId]: _gone, ...rest } = state.enhancements
      return { ...state, enhancements: rest }
    }
  }
}
