/**
 * Shapes crossing the native boundary.
 *
 * Mirrors the Rust serde models (camelCase). Keep in sync with
 * `src-tauri/src/config.rs` and `src-tauri/src/services/`.
 */

/** Serialized `AppConfig` from Rust. */
export interface AppConfigDto {
  productName: string
  version: string
  identifier: string
  debug: boolean
}

/** Serialized `SystemInfo` from Rust. */
export interface SystemInfoDto {
  osFamily: string
  arch: string
  appDataDir: string
}

/**
 * Serialized `AppError` from Rust. The native layer guarantees only these
 * two fields ever reach the UI — no internal detail, no paths, no stack.
 */
export interface AppErrorPayload {
  code:
    | 'invalid_image'
    | 'unsupported_format'
    | 'processing_failed'
    | 'insufficient_resources'
    | 'permission_denied'
    | 'file_missing'
    | 'file_too_large'
    | 'unexpected_error'
  message: string
}

/** Narrow an unknown thrown value from `invoke` into an AppErrorPayload. */
export function isAppErrorPayload(value: unknown): value is AppErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    typeof (value as AppErrorPayload).code === 'string' &&
    typeof (value as AppErrorPayload).message === 'string'
  )
}

/** Normalize any `invoke` rejection into a displayable error. */
export function toAppError(error: unknown): AppErrorPayload {
  if (isAppErrorPayload(error)) return error
  return {
    code: 'unexpected_error',
    message: 'Something went wrong while contacting the application core.',
  }
}

/**
 * ── Stage 03: image import ──────────────────────────────────────────
 */

/** Format labels as serialized by Rust's `ImageFormatLabel`. */
export type ImageFormatLabel = 'JPEG' | 'PNG' | 'WebP'

/** Serialized `ImportedImage` from Rust. */
export interface ImportedImageDto {
  /** Canonical path — doubles as the stable id and dedup key. */
  id: string
  /** File name only; the full path is deliberately not sent. */
  name: string
  format: ImageFormatLabel
  width: number
  height: number
  sizeBytes: number
  /** Data URL of a small locally-generated preview. */
  previewDataUrl: string
}

/**
 * Serialized `ImportOutcome` from Rust — the per-file half of an import
 * batch. A batch never fails as a whole.
 */
export type ImportOutcomeDto =
  | { status: 'imported'; image: ImportedImageDto }
  | { status: 'failed'; name: string; error: AppErrorPayload }

/** Runtime guard for the native import payload (defensive at the boundary). */
export function isImportOutcome(value: unknown): value is ImportOutcomeDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.status === 'failed') {
    return typeof v.name === 'string' && isAppErrorPayload(v.error)
  }
  if (v.status === 'imported') {
    const img = v.image as Record<string, unknown> | undefined
    return (
      typeof img === 'object' &&
      img !== null &&
      typeof img.id === 'string' &&
      typeof img.name === 'string' &&
      typeof img.width === 'number' &&
      typeof img.height === 'number' &&
      typeof img.sizeBytes === 'number' &&
      typeof img.previewDataUrl === 'string'
    )
  }
  return false
}
