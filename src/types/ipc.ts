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
