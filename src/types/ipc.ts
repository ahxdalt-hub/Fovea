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
    | 'engine_unavailable'
    | 'model_missing'
    | 'model_corrupt'
    | 'unsupported_scale'
    | 'cancelled'
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

/**
 * ── Stage 04: image viewing ─────────────────────────────────────────
 */

/**
 * Serialized `ImageView` from Rust — the display representation of one
 * imported file. `original` true means the untouched file bytes; false
 * means a high-quality downscale to `deliveredEdge`.
 */
export interface ImageViewDto {
  /** True source width (px) — the delivered view may be smaller. */
  width: number
  /** True source height (px). */
  height: number
  /** Longest edge actually delivered (px). */
  deliveredEdge: number
  /** True when the data URL is the pristine original file. */
  original: boolean
  /** Self-contained data URL for the viewer. */
  dataUrl: string
}

/** Runtime guard for the native view payload. */
export function isImageView(value: unknown): value is ImageViewDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.width === 'number' &&
    typeof v.height === 'number' &&
    typeof v.deliveredEdge === 'number' &&
    typeof v.original === 'boolean' &&
    typeof v.dataUrl === 'string'
  )
}

/**
 * ── Stage 04 contract, fulfilled by Stage 05: enhancement results ───
 */

/**
 * The enhanced counterpart of one imported image. Stage 04 defined the
 * shape; the Stage 05 engine produces it and Stage 06's controls drive it.
 * The UI must still treat `null`/absent as the honest normal state, never
 * a placeholder image.
 */
export interface ImageEnhancementDto {
  /** The `ImportedImageDto.id` this result belongs to. */
  imageId: string
  /** Data URL of the enhanced image (the engine's actual output). */
  dataUrl: string
  /** Enhanced dimensions — an upscale is larger than the source. */
  width: number
  height: number
  /** Human label for the result, e.g. "4× · Standard". */
  label: string
  /** Dev-QA fixtures only; real engine output never sets this. */
  dev?: boolean
}

/**
 * ── Stage 05/06: local AI inference + enhancement controls ───────────
 */

/** Enhancement modes — keys match Rust `EnhanceMode::key()` exactly.
 * Each is genuinely different processing (different model or a real
 * post-pass), or it would not exist in the UI. */
export type EnhanceModeKey = 'standard' | 'natural' | 'detail'

/** Serialized `EnhanceResult` from Rust (the `enhance_image` reply). */
export interface EnhanceResultDto {
  /** The imported image's canonical id this result belongs to. */
  imageId: string
  /** Pixora's committed output file path (export uses it server-side). */
  filePath: string
  width: number
  height: number
  /** e.g. "4× · Standard". */
  label: string
  /** Engine device: "DirectML GPU" | "CPU". */
  engine: string
  /** Display-size data URL for the compare view. */
  dataUrl: string
}

/**
 * Serialized `EnhanceEvent` — the progress stream from the native job.
 * `preparing` carries the server-generated job id (the cancel handle);
 * `device` reports the engine path an attempt actually runs on plus the
 * tile size the memory budget chose (re-emitted if a GPU failure retries
 * on CPU); `processing.done/total` are completed tiles: a real
 * measurement, never an invented percentage.
 */
export type EnhanceEventDto =
  | { phase: 'preparing'; jobId: string }
  | { phase: 'device'; device: string; tile: number }
  | { phase: 'processing'; done: number; total: number }
  | { phase: 'completing' }
  | { phase: 'completed' }
  | { phase: 'failed'; code: string; message: string }
  | { phase: 'cancelled' }

/** Runtime guard for the native progress stream. */
export function isEnhanceEvent(value: unknown): value is EnhanceEventDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  switch (v.phase) {
    case 'preparing':
      return typeof v.jobId === 'string'
    case 'device':
      return typeof v.device === 'string' && typeof v.tile === 'number'
    case 'completing':
    case 'completed':
    case 'cancelled':
      return true
    case 'processing':
      return typeof v.done === 'number' && typeof v.total === 'number'
    case 'failed':
      return typeof v.code === 'string' && typeof v.message === 'string'
    default:
      return false
  }
}

/** Runtime guard for the enhance result payload. */
export function isEnhanceResult(value: unknown): value is EnhanceResultDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.imageId === 'string' &&
    typeof v.filePath === 'string' &&
    typeof v.width === 'number' &&
    typeof v.height === 'number' &&
    typeof v.label === 'string' &&
    typeof v.engine === 'string' &&
    typeof v.dataUrl === 'string'
  )
}

/** One model's state, per `ModelStatus` in Rust. */
export interface ModelStatusDto {
  id: string
  label: string
  scale: number
  /** "ready" | "missing" | "corrupt" */
  state: string
  /** The enhancement mode this model backs ("standard" | "natural"), or
   * "none" for models not wired to a visible mode. */
  mode: string
}

/** One enhancement mode's availability, per `ModeStatus` in Rust. */
export interface ModeStatusDto {
  key: string
  label: string
  description: string
  /** The model behind the mode is installed, validated, and runnable. */
  available: boolean
}

/** Serialized `InferenceStatus` from Rust — engine readiness. */
export interface InferenceStatusDto {
  /** "DirectML GPU" | "CPU" — informational only; the UI never branches. */
  device: string
  models: ModelStatusDto[]
  /** True when at least one validated model is installed. */
  ready: boolean
  /** Product upscale factors the installed models genuinely deliver. */
  scales: number[]
  /** Every mode the product knows about, with per-mode availability. */
  modes: ModeStatusDto[]
  /** Where the user can drop model files (display only). */
  modelsDirDisplay: string
}

/** Runtime guard for the inference status payload. */
export function isInferenceStatus(value: unknown): value is InferenceStatusDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.device === 'string' &&
    Array.isArray(v.models) &&
    v.models.every(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as ModelStatusDto).id === 'string' &&
        typeof (m as ModelStatusDto).state === 'string',
    ) &&
    typeof v.ready === 'boolean' &&
    Array.isArray(v.scales) &&
    v.scales.every((s) => typeof s === 'number') &&
    Array.isArray(v.modes) &&
    v.modes.every(
      (m) =>
        typeof m === 'object' &&
        m !== null &&
        typeof (m as ModeStatusDto).key === 'string' &&
        typeof (m as ModeStatusDto).available === 'boolean',
    ) &&
    typeof v.modelsDirDisplay === 'string'
  )
}

/**
 * ── Stage 06: export ──────────────────────────────────────────────────
 */

/** Export formats — keys match Rust `ExportFormat::key()`. */
export type ExportFormatKey = 'png' | 'jpeg' | 'webp'

/** Serialized `ExportResult` from Rust (the `export_enhanced_image` reply). */
export interface ExportResultDto {
  filePath: string
  fileName: string
  folder: string
  format: string
  bytes: number
}

/** Runtime guard for the export result payload. */
export function isExportResult(value: unknown): value is ExportResultDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.filePath === 'string' &&
    typeof v.fileName === 'string' &&
    typeof v.folder === 'string' &&
    typeof v.format === 'string' &&
    typeof v.bytes === 'number'
  )
}

/**
 * ── Stage 07: hardware diagnostics ────────────────────────────────────
 */

/** One DXGI adapter, per `GpuInfo` in Rust's hardware service. */
export interface GpuInfoDto {
  name: string
  /** PCI vendor id (0x10DE NVIDIA, 0x1002 AMD, 0x8086 Intel …). */
  vendorId: number
  dedicatedVideoBytes: number
  sharedSystemBytes: number
  /** Software rasterizer (Microsoft Basic Render Driver). */
  software: boolean
  /** Passed a real DirectX 12 feature-level 12_0 device probe. */
  directx12: boolean
}

/** The machine snapshot the engine budgets against, per `HardwareInfo`. */
export interface HardwareInfoDto {
  cpuName: string
  physicalCores: number
  logicalProcessors: number
  totalMemoryBytes: number
  availableMemoryBytes: number
  gpus: GpuInfoDto[]
}

/** Serialized `DiagnosticsDto` from Rust (`get_diagnostics`). */
export interface DiagnosticsDto {
  hardware: HardwareInfoDto
  /** Device a new session will use: "DirectML GPU" | "CPU". */
  engineDevice: string
  /** The engine's hardware-derived memory ceilings, in bytes. */
  maxTileBytes: number
  maxBandBytes: number
  /** Which pool the tile budget is squeezed by (for display). */
  memoryLimit: string
}

/** Runtime guard for the diagnostics payload. */
export function isDiagnostics(value: unknown): value is DiagnosticsDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const hw = v.hardware as Record<string, unknown> | undefined
  return (
    typeof hw === 'object' &&
    hw !== null &&
    typeof hw.cpuName === 'string' &&
    Array.isArray(hw.gpus) &&
    hw.gpus.every(
      (g) =>
        typeof g === 'object' &&
        g !== null &&
        typeof (g as GpuInfoDto).name === 'string' &&
        typeof (g as GpuInfoDto).directx12 === 'boolean',
    ) &&
    typeof v.engineDevice === 'string' &&
    typeof v.maxTileBytes === 'number' &&
    typeof v.maxBandBytes === 'number' &&
    typeof v.memoryLimit === 'string'
  )
}
