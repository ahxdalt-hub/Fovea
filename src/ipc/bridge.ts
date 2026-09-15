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
  AppConfigDto,
  EnhanceEventDto,
  EnhanceResultDto,
  ImportOutcomeDto,
  ImageViewDto,
  InferenceStatusDto,
  SystemInfoDto,
} from '../types/ipc'
import { isEnhanceResult, isInferenceStatus, isImageView } from '../types/ipc'
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
 * this machine). `onEvent` receives honest phase updates — preparing,
 * processing (real completed-tile counts), completing, then a terminal
 * completed/failed/cancelled. Returns the result once the output file
 * is committed; rejects with `AppErrorPayload` on failure.
 *
 * The Tauri `Channel` is created per call and closed automatically when
 * the command settles. Outside Tauri (browser preview/tests) this throws
 * the same safe shape the other commands use.
 */
export async function enhanceImage(
  imageId: string,
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
  channel.onmessage = (event) => onEvent(event)
  const raw: unknown = await invoke('enhance_image', { imageId, onEvent: channel })
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
