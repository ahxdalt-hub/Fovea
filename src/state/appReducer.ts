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
  EnhanceEventDto,
  ImageEnhancementDto,
  ImportedImageDto,
  InferenceStatusDto,
  SystemInfoDto,
} from '../types/ipc'

/** Native connection lifecycle. */
export type CoreStatus = 'connecting' | 'ready' | 'error'

/** Primary navigation destinations in the shell. */
export type ViewId = 'enhance' | 'batch' | 'history'

/** Theme preference; `system` follows the OS and stores no attribute. */
export type ThemePreference = 'system' | 'light' | 'dark'

/**
 * The six honest phases of an enhancement job, mirroring the native
 * `EnhanceEvent` stream. `processing` carries real completed-tile
 * counts — the UI derives a fraction from them, never an estimate.
 */
export type EnhancePhase =
  'preparing' | 'processing' | 'completing' | 'completed' | 'failed' | 'cancelled'

/** The live (or just-finished) enhancement job, if any. One at a time —
 * the native engine enforces the same, so the UI never queues illusions. */
export interface EnhanceJob {
  imageId: string
  /** Server-generated job id, received with the `preparing` event;
   * the handle `cancel_enhancement` needs. */
  jobId: string | null
  phase: EnhancePhase
  done: number
  total: number
  /** True once the user pressed cancel, before the terminal event. */
  cancelling: boolean
  /** Terminal failure detail, already user-safe. */
  error: AppErrorPayload | null
}

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
  /**
   * Engine/model readiness from the native side (Stage 05). Null until
   * first fetched; the Enhance view shows an honest "install the model"
   * hint instead of a dead button when it is missing.
   */
  inference: InferenceStatusDto | null
  /** The single live enhancement job, if any (Stage 05). */
  enhanceJob: EnhanceJob | null
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
  | { type: 'inference/set'; status: InferenceStatusDto }
  | { type: 'enhance/start'; imageId: string }
  | { type: 'enhance/event'; event: EnhanceEventDto }
  | { type: 'enhance/cancelRequested' }
  | { type: 'enhance/clear' }

export const initialState: AppState = {
  coreStatus: 'connecting',
  config: null,
  systemInfo: null,
  error: null,
  images: [],
  selectedImageId: null,
  enhancements: {},
  importing: false,
  inference: null,
  enhanceJob: null,
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
      // A job running on the removed image is no longer meaningful —
      // drop its UI state too (the native job completes/cleans on its
      // own; cancelling mid-run is a later-stage refinement).
      const enhanceJob = state.enhanceJob?.imageId === action.id ? null : state.enhanceJob
      return {
        ...state,
        images,
        enhancements,
        enhanceJob,
        // Dangling selection resets to the first remaining image (or null).
        selectedImageId:
          state.selectedImageId === action.id ? (images[0]?.id ?? null) : state.selectedImageId,
      }
    }
    case 'images/clear':
      return { ...state, images: [], selectedImageId: null, enhancements: {}, enhanceJob: null }
    case 'images/select':
      return { ...state, selectedImageId: action.id }
    case 'enhancements/set':
      // The Stage 05 engine dispatches through here when a job's result
      // arrives. Keyed by image id so re-running an enhancement replaces
      // the previous result cleanly.
      return {
        ...state,
        enhancements: { ...state.enhancements, [action.enhancement.imageId]: action.enhancement },
      }
    case 'enhancements/clear': {
      if (!action.imageId) return { ...state, enhancements: {} }
      const { [action.imageId]: _gone, ...rest } = state.enhancements
      return { ...state, enhancements: rest }
    }
    case 'inference/set':
      return { ...state, inference: action.status }
    case 'enhance/start':
      // A fresh job always replaces whatever finished state lingered;
      // the id is unknown until the native `preparing` event arrives.
      return {
        ...state,
        enhanceJob: {
          imageId: action.imageId,
          jobId: null,
          phase: 'preparing',
          done: 0,
          total: 0,
          cancelling: false,
          error: null,
        },
      }
    case 'enhance/event': {
      const job = state.enhanceJob
      if (!job) return state // events for an unknown/cleared job are dropped
      const e = action.event
      switch (e.phase) {
        case 'preparing':
          return { ...state, enhanceJob: { ...job, jobId: e.jobId } }
        case 'processing':
          // Guard against a stale/out-of-order event clobbering a
          // terminal phase; tile counts are monotonic from native.
          if (job.phase === 'failed' || job.phase === 'cancelled') return state
          return {
            ...state,
            enhanceJob: { ...job, phase: 'processing', done: e.done, total: e.total },
          }
        case 'completing':
          return { ...state, enhanceJob: { ...job, phase: 'completing' } }
        case 'completed':
          return {
            ...state,
            enhanceJob: {
              ...job,
              phase: 'completed',
              done: job.total,
              total: job.total,
              cancelling: false,
            },
          }
        case 'failed':
          // A cancelled job reports through `cancelled`; the command's
          // rejection carrying `cancelled` must not rewrite it to failed.
          if (job.phase === 'cancelled') return state
          return {
            ...state,
            enhanceJob: {
              ...job,
              phase: 'failed',
              cancelling: false,
              error: { code: e.code as AppErrorPayload['code'], message: e.message },
            },
          }
        case 'cancelled':
          return { ...state, enhanceJob: { ...job, phase: 'cancelled', cancelling: false } }
      }
      return state
    }
    case 'enhance/cancelRequested':
      // The UI asked to cancel; the job stays visible with its real
      // phase until the native terminal event confirms the stop.
      return state.enhanceJob
        ? { ...state, enhanceJob: { ...state.enhanceJob, cancelling: true } }
        : state
    case 'enhance/clear':
      return { ...state, enhanceJob: null }
  }
}
