/**
 * Application state — types and pure reducer.
 *
 * Stage 01 deliberately avoids a state library: one context + reducer is
 * enough for startup status and shell UI state. The shape here (typed
 * actions, single pure reducer) is what later feature stores will follow.
 * Stage 10 added `settings` — persisted user preferences live in their
 * own validated module (`./settings`); the reducer only stores whole
 * records it is handed.
 */
import type {
  AppConfigDto,
  AppErrorPayload,
  BatchEventDto,
  BatchItemDto,
  BatchSnapshotDto,
  EnhanceEventDto,
  ExportResultDto,
  HistorySnapshotDto,
  ImageEnhancementDto,
  ImportedImageDto,
  InferenceStatusDto,
  SystemInfoDto,
} from '../types/ipc'
import { DEFAULT_SETTINGS, readSettings, resolveStartupView, type FoveaSettings } from './settings'

/** Native connection lifecycle. */
export type CoreStatus = 'connecting' | 'ready' | 'error'

/** The history store's read lifecycle (Stage 09). Kept in app state so
 * the History view and the cold-start recent row share one honest view
 * of the journal — and so loading it happens through dispatch, matching
 * how every other native read in this app is driven. */
export type HistoryStatus = 'idle' | 'loading' | 'ready' | 'error'

/** Primary navigation destinations in the shell. */
export type ViewId = 'enhance' | 'batch' | 'history'

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
  /** Stage 07: the device the running attempt reports ("DirectML GPU" |
   * "CPU"), from the native `device` event — a fact about the engine,
   * never a UI-side guess. Re-set if the job's path changes mid-run. */
  device: string | null
  /** True once the user pressed cancel, before the terminal event. */
  cancelling: boolean
  /** Terminal failure detail, already user-safe. */
  error: AppErrorPayload | null
}

/**
 * The shell's own UI state (where you are, what is open). Preferences —
 * including appearance — live in persisted settings (Stage 10); this
 * slice is session-shaped navigation state only.
 */
export interface UiState {
  view: ViewId
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
  /** Stage 06/10: the user's persisted preferences (appearance, processing
   * defaults, export defaults, performance). The Enhance strip reads
   * `processing` and writes back through it, so the workspace choice and
   * the Settings page are one value, not two. */
  settings: FoveaSettings
  /** Stage 06: the last export's result per image id — proof the file
   * landed, shown in the completion state without a second source. */
  exports: Record<string, ExportResultDto>
  /**
   * Stage 08: the live (or just-finished) batch queue. `null` until a
   * batch starts. The native snapshot is the source of truth; per-item
   * events reconcile into it with terminal-state protection (a stale
   * progress event can never overwrite a completed item).
   */
  batch: BatchSnapshotDto | null
  /**
   * Stage 09: the local processing journal + recent files. `null` until
   * first fetched. Re-read from the native store on entry to History and
   * after every batch — never invented or cached across a restart.
   */
  history: HistorySnapshotDto | null
  /** Load lifecycle for `history` (kept here so views sync by dispatch,
   * never by a setState inside an effect). */
  historyStatus: HistoryStatus
  /** User-safe message when the last history read failed. */
  historyError: string | null
  ui: UiState
}

export type AppAction =
  | { type: 'core/connecting' }
  | { type: 'core/ready'; config: AppConfigDto; systemInfo: SystemInfoDto }
  | { type: 'core/error'; error: AppErrorPayload }
  | { type: 'ui/navigate'; view: ViewId }
  | { type: 'ui/retryCore' }
  | { type: 'ui/settings'; open: boolean }
  | { type: 'settings/set'; settings: FoveaSettings }
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
  | { type: 'exports/set'; imageId: string; result: ExportResultDto }
  | { type: 'batch/snapshot'; snapshot: BatchSnapshotDto }
  | { type: 'batch/event'; event: BatchEventDto }
  | { type: 'batch/clear' }
  | { type: 'history/loading' }
  | { type: 'history/loaded'; snapshot: HistorySnapshotDto }
  | { type: 'history/error'; message: string }

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
  settings: DEFAULT_SETTINGS,
  exports: {},
  batch: null,
  history: null,
  historyStatus: 'idle',
  historyError: null,
  ui: {
    view: 'enhance',
    settingsOpen: false,
  },
}

/** Fresh session state reading persisted preferences. The provider uses
 * this lazily so a remount (or a later window) picks up what the previous
 * one stored; `initialState` above is the snapshot for tests/static use.
 * The opening view follows the startup setting (Stage 10). */
export function createInitialState(): AppState {
  const settings = readSettings()
  return {
    ...initialState,
    settings,
    ui: { ...initialState.ui, view: resolveStartupView(settings) },
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
    case 'ui/settings':
      return { ...state, ui: { ...state.ui, settingsOpen: action.open } }
    case 'settings/set':
      // The settings module owns validation; a full, normalized record
      // arrives here and replaces the old one as-is.
      return state.settings === action.settings ? state : { ...state, settings: action.settings }
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
          device: null,
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
        case 'device':
          // The engine announcing which path (and tile size) an attempt
          // runs on. A retry may re-emit it with a different device; the
          // last truth wins. It never rewrites a terminal phase.
          if (job.phase === 'failed' || job.phase === 'cancelled') return state
          return { ...state, enhanceJob: { ...job, device: e.device } }
        case 'processing':
          // Guard against a stale/out-of-order event clobbering a
          // terminal phase; tile counts are monotonic from native.
          if (job.phase === 'failed' || job.phase === 'cancelled') return state
          return {
            ...state,
            enhanceJob: { ...job, phase: 'processing', done: e.done, total: e.total },
          }
        case 'completing':
          if (job.phase === 'failed' || job.phase === 'cancelled') return state
          return { ...state, enhanceJob: { ...job, phase: 'completing' } }
        case 'completed':
          // A cancelled or failed job is already settled: a `completed`
          // that arrives late (the cancel landed mid-commit) must not
          // turn "Cancelled — nothing was written" into a success the
          // user never got. Terminal phases also keep their counts.
          if (job.phase === 'failed' || job.phase === 'cancelled') return state
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
    case 'exports/set':
      return { ...state, exports: { ...state.exports, [action.imageId]: action.result } }
    case 'batch/snapshot':
      // A snapshot replaces the queue wholesale — it is authoritative
      // (comes from the native source of truth). A no-op when identical.
      return state.batch === action.snapshot ? state : { ...state, batch: action.snapshot }
    case 'batch/event': {
      const snapshot = state.batch
      if (!snapshot) return state // events before a snapshot are dropped
      const items = applyBatchEvent(snapshot.items, action.event)
      // No item moved (terminal guard, monotonic guard, or unknown id):
      // return the identical state so React skips the re-render and tests
      // can assert reference stability.
      if (items === snapshot.items) return state
      // Reconcile `running`: an item moving out of waiting/processing
      // can drain the last work; the native snapshot is refreshed on the
      // next sync, but the UI must not show a phantom in-flight batch.
      const stillRunning = items.some((i) => i.state === 'waiting' || i.state === 'processing')
      return {
        ...state,
        batch: { ...snapshot, items, running: snapshot.running && stillRunning },
      }
    }
    case 'batch/clear':
      return { ...state, batch: null }
    case 'history/loading':
      return { ...state, historyStatus: 'loading', historyError: null }
    case 'history/loaded':
      return { ...state, history: action.snapshot, historyStatus: 'ready', historyError: null }
    case 'history/error':
      return { ...state, historyStatus: 'error', historyError: action.message }
  }
}

/** Terminal batch item states — never overwritten by a later event. */
const TERMINAL_BATCH: ReadonlySet<BatchItemDto['state']> = new Set([
  'completed',
  'failed',
  'cancelled',
])

/**
 * Fold one native batch event onto the item list. Guards:
 * - terminal items ignore everything (a late/stale event can't resurrect
 *   or rewrite finished work);
 * - progress is monotonic (a smaller `done` from an out-of-order event
 *   never moves an item backward);
 * - every branch returns a *new* array only when something changed, so
 *   an unknown/duplicate event keeps referential stability (React skips
 *   the re-render, and tests can assert identity).
 */
export function applyBatchEvent(items: BatchItemDto[], event: BatchEventDto): BatchItemDto[] {
  const index = items.findIndex((i) => i.id === event.itemId)
  const item = index < 0 ? undefined : items[index]
  if (!item) return items // unknown item id — stale or already gone
  if (TERMINAL_BATCH.has(item.state)) return items

  let next: BatchItemDto | null = null
  switch (event.type) {
    case 'started':
      if (item.state !== 'waiting') break
      next = { ...item, state: 'processing' }
      break
    case 'device':
      next = { ...item, device: event.device }
      break
    case 'progress':
      // Monotonic: only advance the completed-tile count.
      if (event.done < item.done) break
      next = { ...item, done: event.done, total: event.total }
      break
    case 'saving':
      // Still processing (the 5-state model has no separate 'saving');
      // mark the tile count complete so the bar honestly reads full.
      next = { ...item, done: item.total > 0 ? item.total : item.done }
      break
    case 'completed':
      next = {
        ...item,
        state: 'completed',
        done: item.total,
        error: null,
        cancelling: false,
      }
      break
    case 'failed':
      next = {
        ...item,
        state: 'failed',
        error: { code: event.code as AppErrorPayload['code'], message: event.message },
        cancelling: false,
      }
      break
    case 'cancelled':
      next = { ...item, state: 'cancelled', cancelling: false }
      break
  }
  if (!next) return items // event didn't move the item — keep identity
  const copy = items.slice()
  copy[index] = next
  return copy
}
