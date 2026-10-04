/**
 * Typed bridge to native Tauri commands.
 *
 * This module is the ONLY place the frontend imports @tauri-apps/api invoke.
 * Components and state call these functions; if the native API changes,
 * only this file changes. Errors arrive as `AppErrorPayload`
 * (`{ code, message }`) — see `src/types/ipc.ts`.
 */
import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  ActivationResultDto,
  AppConfigDto,
  BatchConfigPayload,
  BatchEventDto,
  BatchItemPayload,
  BatchSnapshotDto,
  DiagnosticsDto,
  EnhanceEventDto,
  EnhanceRecipe,
  EnhanceResultDto,
  ExportFormatKey,
  ExportResultDto,
  HistorySnapshotDto,
  ImportOutcomeDto,
  ImageViewDto,
  InferenceStatusDto,
  LicenseStatusDto,
  SystemInfoDto,
} from '../types/ipc'
import {
  isActivationResult,
  isBatchEvent,
  isBatchSnapshot,
  isDiagnostics,
  isEnhanceEvent,
  isEnhanceResult,
  isExportResult,
  isHistorySnapshot,
  isInferenceStatus,
  isImageView,
  isLicenseStatus,
} from '../types/ipc'
import { previewInvoke, shouldUsePreviewBridge } from './previewBridge'

/** Build configuration owned by the native side. */
export function getConfig(): Promise<AppConfigDto> {
  if (shouldUsePreviewBridge()) return previewInvoke('get_config') as Promise<AppConfigDto>
  return invoke<AppConfigDto>('get_config')
}

/** Native runtime snapshot (OS, arch, app data location). */
export function getSystemInfo(): Promise<SystemInfoDto> {
  if (shouldUsePreviewBridge()) return previewInvoke('get_system_info') as Promise<SystemInfoDto>
  return invoke<SystemInfoDto>('get_system_info')
}

/** Relay a console message into the native log file. Fire-and-forget. */
export function writeFrontendLog(level: 'debug' | 'info' | 'warn' | 'error', message: string) {
  if (shouldUsePreviewBridge()) return
  void invoke('write_frontend_log', { level, message }).catch(() => {
    // Log relay failing must never break the UI or loop.
  })
}

/**
 * Open the native, image-filtered file picker. Returns chosen paths
 * (empty on cancel). The dialog itself lives on the Rust side, so the
 * webview needs no dialog or filesystem permission.
 */
export function pickImageFiles(): Promise<string[]> {
  if (shouldUsePreviewBridge()) return previewInvoke('pick_image_files') as Promise<string[]>
  return invoke<string[]>('pick_image_files')
}

/**
 * Validate and import a batch of paths. Each file reports its own outcome;
 * the call itself only rejects on a whole-batch failure (e.g. the core is
 * unreachable).
 */
export function importImages(paths: string[]): Promise<ImportOutcomeDto[]> {
  if (shouldUsePreviewBridge()) return previewInvoke('import_images') as Promise<ImportOutcomeDto[]>
  return invoke<ImportOutcomeDto[]>('import_images', { paths })
}

/**
 * Load the display representation of an imported image (Stage 04).
 * `maxEdge` caps the delivered longest edge; omit for the native default.
 * Guarded at the boundary like every native payload.
 */
export async function loadImageView(imageId: string, maxEdge?: number): Promise<ImageViewDto> {
  if (shouldUsePreviewBridge()) {
    const raw = await previewInvoke('load_image_view')
    if (isImageView(raw)) return raw
    throw { code: 'unexpected_error', message: 'Image view is unavailable in browser preview.' }
  }
  const raw: unknown = await invoke('load_image_view', { imageId, maxEdge: maxEdge ?? null })
  if (!isImageView(raw)) {
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  return raw
}

/**
 * ── Stage 05: local AI enhancement ───────────────────────────────────
 */

/**
 * Enhance one imported image with the local AI engine (nothing leaves
 * this machine). `recipe.mode` selects the enhancement behavior (each mode
 * is a genuinely different model or post-processing pass — see
 * `EnhanceModeKey`), `recipe.scale` the product upscale factor (only values
 * the installed models genuinely deliver are offered by the UI), and
 * `recipe.filter`/`intensity` the finishing look applied to the model's
 * output — pixel math, so it is always available and `original` runs no
 * filter pass at all. `onEvent` receives honest phase updates — preparing,
 * processing (real completed-tile counts), completing, then a terminal
 * completed/failed/cancelled. Returns the result once the output file is
 * committed; rejects with `AppErrorPayload` on failure.
 *
 * The Tauri `Channel` is created per call and closed automatically when
 * the command settles. Outside Tauri (browser preview/tests) this throws
 * the same safe shape the other commands use.
 */
export async function enhanceImage(
  imageId: string,
  recipe: EnhanceRecipe,
  onEvent: (event: EnhanceEventDto) => void,
): Promise<EnhanceResultDto> {
  if (shouldUsePreviewBridge()) {
    await previewInvoke('enhance_image') // no-op in preview; honest failure below
    throw {
      code: 'unexpected_error',
      message: 'The enhancement engine runs in the desktop app.',
    }
  }
  const channel = new Channel<EnhanceEventDto>()
  // Stage 12: the stream is untrusted input too — a malformed event is
  // dropped (and logged) at the boundary instead of reaching the reducer,
  // where a string `done` would compare lexicographically forever.
  channel.onmessage = (event) => {
    if (isEnhanceEvent(event)) onEvent(event)
    else writeFrontendLog('warn', 'malformed enhance event dropped')
  }
  const raw: unknown = await invoke('enhance_image', {
    imageId,
    mode: recipe.mode,
    scale: recipe.scale,
    filter: recipe.filter,
    intensity: recipe.intensity,
    onEvent: channel,
  })
  if (!isEnhanceResult(raw)) {
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  return raw
}

/** Cancel a running enhancement; resolves true if a live job received
 * the signal. Racing with natural completion is safe — a false here
 * simply means the job already ended. */
export function cancelEnhancement(jobId: string): Promise<boolean> {
  return invoke<boolean>('cancel_enhancement', { jobId })
}

/** Engine + model readiness. Guarded at the boundary like every payload. */
export async function getInferenceStatus(): Promise<InferenceStatusDto> {
  if (shouldUsePreviewBridge()) {
    const raw = await previewInvoke('get_inference_status')
    if (isInferenceStatus(raw)) return raw
    throw {
      code: 'unexpected_error',
      message: 'Engine status is unavailable in browser preview.',
    }
  }
  const raw: unknown = await invoke('get_inference_status')
  if (!isInferenceStatus(raw)) {
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  return raw
}

/**
 * ── Stage 06: export ──────────────────────────────────────────────────
 */

/**
 * Open the native folder picker for the export destination. Returns the
 * chosen folder path (empty string on cancel — the caller then keeps the
 * default). The dialog lives on the Rust side; the webview holds no
 * dialog or filesystem permission.
 */
export async function pickExportFolder(): Promise<string> {
  if (shouldUsePreviewBridge()) return ''
  const paths = await invoke<string[]>('pick_export_folder')
  return Array.isArray(paths) ? (paths[0] ?? '') : ''
}

/**
 * Export the committed enhancement result of `imageId` into `folder`
 * ("" = Fovea's default export folder) as `format` at `quality`
 * (1–100; PNG ignores it — its export is a lossless copy of the master).
 * The source is resolved server-side from the engine's own output
 * registry, so no client-supplied path is ever read or written blindly.
 */
export async function exportEnhancedImage(
  imageId: string,
  format: ExportFormatKey,
  quality: number,
  folder: string,
): Promise<ExportResultDto> {
  if (shouldUsePreviewBridge()) {
    throw {
      code: 'unexpected_error',
      message: 'Export runs in the desktop app.',
    }
  }
  const raw: unknown = await invoke('export_enhanced_image', {
    imageId,
    format,
    quality: Math.round(quality),
    folder,
  })
  if (!isExportResult(raw)) {
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  return raw
}

/**
 * ── Stage 07: hardware diagnostics ────────────────────────────────────
 */

/**
 * What the engine sees about this machine and the memory ceilings it
 * derives from that (GPU adapters + VRAM, CPU cores, RAM, which device a
 * new session lands on). Purely local hardware facts — no image data, no
 * paths, no identity. Guarded at the boundary like every payload; in the
 * browser preview there is no hardware to report, so it throws the same
 * honest shape the other native-only commands use.
 */
export async function getDiagnostics(): Promise<DiagnosticsDto> {
  if (shouldUsePreviewBridge()) {
    throw {
      code: 'unexpected_error',
      message: 'Hardware diagnostics run in the desktop app.',
    }
  }
  const raw: unknown = await invoke('get_diagnostics')
  if (!isDiagnostics(raw)) {
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  return raw
}

/**
 * ── Stage 08: batch queue ─────────────────────────────────────────────
 */

/**
 * Start (or replace) the batch queue. Each item runs the real engine
 * sequentially through the single-slot memory budget; `onEvent` receives
 * per-item progress, and the returned snapshot renders the full queue
 * before the first event lands. Rejects honestly when the engine is busy.
 */
export async function startBatch(
  items: BatchItemPayload[],
  output: BatchConfigPayload,
  onEvent: (event: BatchEventDto) => void,
): Promise<BatchSnapshotDto> {
  if (shouldUsePreviewBridge()) {
    throw {
      code: 'unexpected_error',
      message: 'Batch processing runs in the desktop app.',
    }
  }
  const channel = new Channel<BatchEventDto>()
  // Same boundary rule as the single-image stream: guard or drop.
  channel.onmessage = (event) => {
    if (isBatchEvent(event)) onEvent(event)
    else writeFrontendLog('warn', 'malformed batch event dropped')
  }
  const raw: unknown = await invoke('start_batch', { items, output, onEvent: channel })
  if (!isBatchSnapshot(raw)) {
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  return raw
}

/** Cancel one queued item (mid-run or from the queue). Resolves false
 * when the session or item is gone. */
export function cancelBatchItem(itemId: string): Promise<boolean> {
  if (shouldUsePreviewBridge()) return Promise.resolve(false)
  return invoke<boolean>('cancel_batch_item', { itemId })
}

/** Cancel every item in the running batch (committed results are kept). */
export function cancelBatchAll(): Promise<null> {
  if (shouldUsePreviewBridge()) return Promise.resolve(null)
  return invoke<null>('cancel_batch_all')
}

/** Re-queue failed/cancelled items; returns the updated snapshot (null
 * when no session exists). */
export async function retryBatchFailed(): Promise<BatchSnapshotDto | null> {
  if (shouldUsePreviewBridge()) return null
  const raw: unknown = await invoke<BatchSnapshotDto | null>('retry_batch_failed')
  if (raw === null) return null
  return isBatchSnapshot(raw) ? raw : null
}

/** The current queue snapshot for late subscribers (null when none). */
export async function getBatchSnapshot(): Promise<BatchSnapshotDto | null> {
  if (shouldUsePreviewBridge()) return null
  const raw: unknown = await invoke<BatchSnapshotDto | null>('get_batch_snapshot')
  if (raw === null) return null
  return isBatchSnapshot(raw) ? raw : null
}

/**
 * ── Stage 09: history + recent files ──────────────────────────────────
 */

/** Read the local journal + recent-files snapshot (paths + measurements,
 * never image bytes). Browser preview has no store → honest empty. */
export async function getHistory(): Promise<HistorySnapshotDto> {
  if (shouldUsePreviewBridge()) {
    return { entries: [], recents: [] }
  }
  const raw: unknown = await invoke<HistorySnapshotDto>('get_history')
  if (!isHistorySnapshot(raw)) {
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  return raw
}

/** Wipe the journal + recent list. Files on disk are never touched. */
export function clearHistory(): Promise<null> {
  if (shouldUsePreviewBridge()) return Promise.resolve(null)
  return invoke<null>('clear_history')
}

/**
 * ── Stage 10: settings ────────────────────────────────────────────────
 */

/** The projection of user settings the native side must honour: hardware
 * path, power mode, and the recents switch. Mirrored to `settings.json`
 * in the app-data dir so a restart honours them before any job runs. */
export interface EngineHintsDto {
  cpuOnly: boolean
  fullPower: boolean
  recordRecents: boolean
}

/** Push the engine-relevant hints to the native side. Fire-and-forget by
 * contract: a failed mirror must never break the UI action that changed
 * a preference, and the in-app defaults (fallbacks) stay honest. In the
 * browser preview there is no engine to inform. */
export function setEngineHints(hints: EngineHintsDto): Promise<null> {
  if (shouldUsePreviewBridge()) return Promise.resolve(null)
  return invoke<null>('set_engine_hints', {
    cpuOnly: hints.cpuOnly,
    fullPower: hints.fullPower,
    recordRecents: hints.recordRecents,
  })
}

/** Open the native log folder in the OS file browser and return its path
 * (for display). Only ever opens the app's own log directory — the
 * argument list is built server-side, never from the client. */
export function openLogsFolder(): Promise<string> {
  if (shouldUsePreviewBridge()) {
    return Promise.reject({
      code: 'unexpected_error',
      message: 'Logs live with the desktop app.',
    })
  }
  return invoke<string>('open_logs_folder')
}

/** Open the folder Fovea last exported into, with the exported file
 * selected when that run wrote one file. Returns the folder path for
 * display. The location is this side's own record of what it wrote — the
 * client never names a folder to open. */
export function openExportFolder(): Promise<string> {
  if (shouldUsePreviewBridge()) {
    return Promise.reject({
      code: 'unexpected_error',
      message: 'Exports live with the desktop app.',
    })
  }
  return invoke<string>('open_export_folder')
}

/**
 * ── Stage 13: licensing ───────────────────────────────────────────────
 *
 * The whole licensing surface, deliberately tiny: status, activate,
 * deactivate. Everything verifies on this machine and nothing here reaches
 * the network. Since Stage 20 the working commands do read the plan — to
 * decide whether they may be *asked* for a paid option — but a license
 * question never interrupts an enhancement already running, and a key buys
 * options, never permission to use files you already made.
 */

/** The local license state, re-verified natively from the stored
 * signature. Guarded like every payload; the browser preview honestly
 * reports an unactivated license (there is no local store to consult). */
export async function getLicenseStatus(): Promise<LicenseStatusDto> {
  if (shouldUsePreviewBridge()) {
    const raw = await previewInvoke('get_license_status')
    if (isLicenseStatus(raw)) return raw
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  const raw: unknown = await invoke('get_license_status')
  if (!isLicenseStatus(raw)) {
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  return raw
}

/** Activate a pasted license key. Fully offline-capable: success needs
 * a valid vendor signature, not an internet connection. Rejects with a
 * human-readable AppErrorPayload on any bad key. */
export async function activateLicense(key: string): Promise<ActivationResultDto> {
  if (shouldUsePreviewBridge()) {
    throw {
      code: 'unexpected_error',
      message: 'Licensing runs in the desktop app.',
    }
  }
  const raw: unknown = await invoke('activate_license', { key })
  if (!isActivationResult(raw)) {
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  return raw
}

/** Forget the stored license on this machine. The key itself remains
 * valid with the vendor; re-entering it re-activates. */
export async function deactivateLicense(): Promise<LicenseStatusDto> {
  if (shouldUsePreviewBridge()) {
    throw {
      code: 'unexpected_error',
      message: 'Licensing runs in the desktop app.',
    }
  }
  const raw: unknown = await invoke('deactivate_license')
  if (!isLicenseStatus(raw)) {
    throw {
      code: 'unexpected_error',
      message: 'The application core returned an unexpected reply.',
    }
  }
  return raw
}
