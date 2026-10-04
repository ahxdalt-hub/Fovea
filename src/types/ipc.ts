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
  /** Where the native log file lives (Stage 10 diagnostics). */
  logsDir: string
  /** Fovea's own export folder — `Documents/Fovea`. Empty when this
   * machine would not hand one over; the UI then keeps its generic label. */
  defaultExportDir: string
  /** The batch sibling — `Documents/Fovea/Batch`. Same empty-means-generic
   * contract as `defaultExportDir`. */
  defaultBatchExportDir: string
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
    | 'insufficient_disk'
    | 'license_invalid'
    | 'license_expired'
    | 'license_revoked'
    | 'license_wrong_machine'
    | 'license_clock_suspect'
    | 'license_unsupported_version'
    | 'license_store_unavailable'
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

/** Finishing filters — keys match Rust `Filter::key()` exactly. A filter is
 * the *look* applied on top of any mode (pure pixel math on the model's
 * output, so it needs no model of its own). `'original'` is the off-switch:
 * no filter pass runs at all. */
export type FilterKey =
  | 'original'
  | 'natural'
  | 'vivid'
  | 'warm'
  | 'cool'
  | 'cinematic'
  | 'soft'
  | 'sharp'
  | 'mono'
  | 'product'
  | 'portrait'

/** Filter strength as a 0-100 amount. The engine is the only place that
 * interprets it — the UI passes the number through unchanged. */
export type FilterIntensity = number

/** One enhancement run, as the client describes it (mirrors the
 * `enhance_image` args): what the model does, how far it scales, and the
 * finishing look applied to the result. */
export interface EnhanceRecipe {
  mode: EnhanceModeKey
  scale: number
  filter: FilterKey
  intensity: FilterIntensity
}

/** Serialized `EnhanceResult` from Rust (the `enhance_image` reply). */
export interface EnhanceResultDto {
  /** The imported image's canonical id this result belongs to. */
  imageId: string
  /** Fovea's committed output file path (export uses it server-side). */
  filePath: string
  width: number
  height: number
  /** True source dimensions (facts from the engine's decode plan). */
  sourceWidth: number
  sourceHeight: number
  /** True master dimensions of the committed output. */
  outputWidth: number
  outputHeight: number
  /** e.g. "4× · Standard". */
  label: string
  /** Engine device: "DirectML GPU" | "CPU". */
  engine: string
  /** Display-size data URL for the compare view. `null` on the batch
   * path (`enhance_without_view`) where no compare view is ever built. */
  dataUrl: string | null
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
    typeof v.sourceWidth === 'number' &&
    typeof v.sourceHeight === 'number' &&
    typeof v.outputWidth === 'number' &&
    typeof v.outputHeight === 'number' &&
    typeof v.label === 'string' &&
    typeof v.engine === 'string' &&
    (typeof v.dataUrl === 'string' || v.dataUrl === null)
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

/** One finishing filter, per `FilterStatus` in Rust. Labels and hints come
 * from native so the strip, the batch preset and Settings can never call
 * the same look two different names. */
export interface FilterStatusDto {
  key: FilterKey
  label: string
  description: string
  /** Filters are pixel math, so this is true for every one — it exists so
   * the UI renders modes and filters through the same shape. */
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
  /** Every finishing filter the product offers, in native words. */
  filters: FilterStatusDto[]
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
    Array.isArray(v.filters) &&
    v.filters.every(
      (f) =>
        typeof f === 'object' &&
        f !== null &&
        typeof (f as FilterStatusDto).key === 'string' &&
        typeof (f as FilterStatusDto).label === 'string' &&
        typeof (f as FilterStatusDto).available === 'boolean',
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
 * ── Stage 08: batch queue ─────────────────────────────────────────────
 */

/** The five honest states one queued item moves through (mirrors Rust
 * `BatchItemState`). `processing` only ever follows a native `started`;
 * `completed` only after the master commits *and* the export lands. */
export type BatchItemStateDto = 'waiting' | 'processing' | 'completed' | 'failed' | 'cancelled'

/** The committed artifact of a completed batch item (`BatchOutput` in Rust).
 * Everything needed to show the result and open it — never image bytes. */
export interface BatchOutputDto {
  filePath: string
  fileName: string
  folder: string
  bytes: number
  sourceWidth: number
  sourceHeight: number
  outputWidth: number
  outputHeight: number
  label: string
  engine: string
}

/** One queued item (`BatchItem` in Rust). */
export interface BatchItemDto {
  id: string
  /** The imported image's canonical path id ('' for a non-imported path). */
  imageId: string
  name: string
  state: BatchItemStateDto
  /** Completed tiles / planned tiles — a real measurement, (0,0) before
   * the first progress event. */
  done: number
  total: number
  /** "DirectML GPU" | "CPU" once the engine reports its path. */
  device: string | null
  error: AppErrorPayload | null
  output: BatchOutputDto | null
  mode: string
  scale: number
  filter: string
  intensity: number
  /** True once a cancel is requested but the terminal state hasn't landed. */
  cancelling: boolean
}

/** Snapshot of the whole queue (`BatchSnapshot` in Rust). */
export interface BatchSnapshotDto {
  items: BatchItemDto[]
  /** True while a worker exists and more work can run. */
  running: boolean
  workerLimit: number
}

/** Per-item streamed progress (`BatchEvent` in Rust), tagged by `type`. */
export type BatchEventDto =
  | { type: 'started'; itemId: string }
  | { type: 'progress'; itemId: string; done: number; total: number }
  | { type: 'device'; itemId: string; device: string }
  | { type: 'saving'; itemId: string }
  | { type: 'completed'; itemId: string }
  | { type: 'failed'; itemId: string; code: string; message: string }
  | { type: 'cancelled'; itemId: string }

function isBatchOutput(value: unknown): value is BatchOutputDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  // Every numeric field the batch view renders must be present and finite
  // — the Stage 12 rule is that a guard-passing payload cannot crash a
  // render (formatDimensions calls both dimensions unconditionally).
  return (
    typeof v.filePath === 'string' &&
    typeof v.fileName === 'string' &&
    typeof v.folder === 'string' &&
    typeof v.bytes === 'number' &&
    Number.isFinite(v.bytes) &&
    typeof v.sourceWidth === 'number' &&
    Number.isFinite(v.sourceWidth) &&
    typeof v.sourceHeight === 'number' &&
    Number.isFinite(v.sourceHeight) &&
    typeof v.outputWidth === 'number' &&
    Number.isFinite(v.outputWidth) &&
    typeof v.outputHeight === 'number' &&
    Number.isFinite(v.outputHeight) &&
    typeof v.label === 'string' &&
    typeof v.engine === 'string'
  )
}

/** Runtime guard for the queue snapshot. */
export function isBatchSnapshot(value: unknown): value is BatchSnapshotDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.running !== 'boolean' || typeof v.workerLimit !== 'number') return false
  if (!Array.isArray(v.items)) return false
  return v.items.every((item) => {
    if (typeof item !== 'object' || item === null) return false
    const i = item as Record<string, unknown>
    const stateOk =
      i.state === 'waiting' ||
      i.state === 'processing' ||
      i.state === 'completed' ||
      i.state === 'failed' ||
      i.state === 'cancelled'
    const outputOk = i.output === null || i.output === undefined || isBatchOutput(i.output)
    const errorOk = i.error === null || i.error === undefined || isAppErrorPayload(i.error)
    return (
      typeof i.id === 'string' &&
      typeof i.name === 'string' &&
      stateOk &&
      typeof i.done === 'number' &&
      typeof i.total === 'number' &&
      outputOk &&
      errorOk
    )
  })
}

/** Runtime guard for a streamed batch event. */
export function isBatchEvent(value: unknown): value is BatchEventDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (typeof v.itemId !== 'string') return false
  switch (v.type) {
    case 'started':
    case 'saving':
    case 'completed':
    case 'cancelled':
      return true
    case 'progress':
      return typeof v.done === 'number' && typeof v.total === 'number'
    case 'device':
      return typeof v.device === 'string'
    case 'failed':
      return typeof v.code === 'string' && typeof v.message === 'string'
    default:
      return false
  }
}

/** A single queued item as the *client* describes it (request arg, mirrors
 * Rust `BatchItemArg`). `path` is the collection's canonical id. */
export interface BatchItemPayload {
  path: string
  name: string
  scale: number
  mode: EnhanceModeKey
  filter: FilterKey
  intensity: FilterIntensity
}

/** Where/how a batch writes results (request arg, mirrors `BatchConfigArg`).
 * `folder: ""` selects Fovea's default batch export folder. */
export interface BatchConfigPayload {
  folder: string
  format: ExportFormatKey
  quality: number
}

/**
 * ── Stage 09: history + recent files ──────────────────────────────────
 */

/** One journal row (`HistoryEntryDto` in Rust), plus the read-time
 * existence flags that tell the UI whether it can still be reopened.
 * `0` dimensions mean "never measured" (a failed run recorded nothing). */
export interface HistoryEntryDto {
  id: string
  sourcePath: string
  fileName: string
  originalWidth: number
  originalHeight: number
  outputWidth: number
  outputHeight: number
  scale: number
  mode: string
  status: 'completed' | 'failed'
  errorMessage: string | null
  /** Unix milliseconds. */
  createdAt: number
  kind: 'single' | 'batch'
  outputPath: string | null
  sourceExists: boolean
  outputExists: boolean
}

/** A recent-file row (`RecentFileDto` in Rust), newest first. The native
 * layer prunes dead pointers at read, so `exists` is always true here —
 * it is kept for honesty and future-proofing. */
export interface RecentFileDto {
  path: string
  name: string
  lastUsedAt: number
  exists: boolean
}

/** The journal snapshot the History view reads (`HistorySnapshot` in Rust). */
export interface HistorySnapshotDto {
  entries: HistoryEntryDto[]
  recents: RecentFileDto[]
}

function isHistoryEntry(value: unknown): value is HistoryEntryDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    typeof v.sourcePath === 'string' &&
    typeof v.fileName === 'string' &&
    typeof v.originalWidth === 'number' &&
    typeof v.outputWidth === 'number' &&
    typeof v.scale === 'number' &&
    typeof v.mode === 'string' &&
    (v.status === 'completed' || v.status === 'failed') &&
    typeof v.createdAt === 'number' &&
    (v.kind === 'single' || v.kind === 'batch') &&
    typeof v.sourceExists === 'boolean' &&
    typeof v.outputExists === 'boolean'
  )
}

/** Runtime guard for the history snapshot payload. */
export function isHistorySnapshot(value: unknown): value is HistorySnapshotDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.entries) || !v.entries.every(isHistoryEntry)) return false
  return (
    Array.isArray(v.recents) &&
    v.recents.every(
      (r) =>
        typeof r === 'object' &&
        r !== null &&
        typeof (r as Record<string, unknown>).path === 'string' &&
        typeof (r as Record<string, unknown>).lastUsedAt === 'number',
    )
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

/**
 * ── Stage 13: licensing ───────────────────────────────────────────────
 */

/** The license lifecycle the settings UI renders. */
export type LicenseState =
  | 'not_activated'
  | 'active'
  | 'expired'
  | 'wrong_machine'
  | 'tampered'
  | 'revoked'
  | 'clock_suspect'

/** Serialized `LicenseStatusDto` from Rust. */
export interface LicenseStatusDto {
  state: LicenseState
  /** 'pro' | 'studio' — null while unactivated. */
  edition: string | null
  holder: string | null
  licenseId: string | null
  issuedAt: number | null
  /** null = perpetual. */
  expiresAt: number | null
  activatedAt: number | null
  machineBound: boolean
  capabilities: string[]
  /** Short fingerprint group for support conversations. */
  machineHint: string
}

/** Serialized `ActivationDto` from Rust. */
export interface ActivationResultDto {
  status: LicenseStatusDto
  alreadyActive: boolean
}

/** Runtime guard for the license status payload. */
export function isLicenseStatus(value: unknown): value is LicenseStatusDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  const states: LicenseState[] = [
    'not_activated',
    'active',
    'expired',
    'wrong_machine',
    'tampered',
    'revoked',
    'clock_suspect',
  ]
  return (
    typeof v.state === 'string' &&
    (states as string[]).includes(v.state) &&
    (v.edition === null || typeof v.edition === 'string') &&
    (v.holder === null || typeof v.holder === 'string') &&
    (v.licenseId === null || typeof v.licenseId === 'string') &&
    (v.issuedAt === null || typeof v.issuedAt === 'number') &&
    (v.expiresAt === null || typeof v.expiresAt === 'number') &&
    (v.activatedAt === null || typeof v.activatedAt === 'number') &&
    typeof v.machineBound === 'boolean' &&
    Array.isArray(v.capabilities) &&
    typeof v.machineHint === 'string'
  )
}

/** Runtime guard for the activation result payload. */
export function isActivationResult(value: unknown): value is ActivationResultDto {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.alreadyActive === 'boolean' && isLicenseStatus(v.status)
}
