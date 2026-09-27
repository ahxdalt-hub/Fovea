/**
 * User settings (Stage 10) — the single place preferences are defined,
 * validated, stored and read.
 *
 * The design rules this module encodes:
 *
 * - **One shape, grouped the way users think.** Four editable groups
 *   (general / processing / export / performance). Every field is
 *   something a photographer or an ecommerce operator can decide without
 *   knowing what a GPU is; anything without a clear user benefit (tile
 *   sizes, buffer ceilings, thread counts) is deliberately absent — the
 *   engine derives those from the hardware and reports them read-only in
 *   Diagnostics.
 * - **Unknown is never trusted.** `readSettings()` runs every stored value
 *   through a normalizer: a missing key falls back to its default, a bad
 *   value falls back too. A hand-edited or half-written settings record
 *   cannot put the app into a state the UI can't render.
 * - **Storage is localStorage, deliberately.** Settings are UI-scale data
 *   (a dozen primitives): synchronous, survives restarts, and readable at
 *   module scope so the first paint already honours the theme. The
 *   settings the *engine* must honour at job time (a forced processor
 *   path, the power mode, the recents switch) are mirrored to the native
 *   side on change — see `bridge.setEngineHints`.
 * - **Migrating old keys is silent and total.** Stages 01–06 wrote the
 *   theme and the enhancement choices under their own keys; the first
 *   read folds them in and removes them, so there is never two answers
 *   to "what is my theme?".
 */
import type { EnhanceModeKey, ExportFormatKey } from '../types/ipc'

/** Theme choice; `system` follows the OS and stores no attribute. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** Which view opens when Pixora starts. */
export type StartupView = 'last' | 'enhance' | 'batch' | 'history'

/**
 * What enhancement runs on. `auto` is Pixora's own decision (GPU when
 * genuinely usable, processor otherwise); `cpu` forces the slower,
 * calmer path — the honest off-switch for a flaky driver, mirroring
 * `GpuPreference` on the Rust side. There is deliberately no "force
 * GPU": the engine must always be allowed to fall back rather than
 * fail, and a choice that can only ever mean "try the GPU, like auto"
 * would be a lie in a settings page.
 */
export type EnginePath = 'auto' | 'cpu'

export interface GeneralSettings {
  theme: ThemePreference
  /** What to show when Pixora starts. */
  startupView: StartupView
  /** Keep the short "pick up where you left off" list. */
  rememberRecentFiles: boolean
  /** How many recent files to offer on a cold start. */
  recentFilesLimit: number
}

export interface ProcessingSettings {
  /** Product upscale the Enhance strip pre-selects (2 | 4). */
  defaultScale: number
  /** Enhancement mode the strip pre-selects. */
  defaultMode: EnhanceModeKey
  /** Which hardware path enhancement runs on. */
  enginePath: EnginePath
}

export interface ExportSettings {
  format: ExportFormatKey
  /** 1–100; only meaningful for the lossy formats. */
  quality: number
  /** "" means Pixora's own export folder. */
  folder: string
}

export interface PerformanceSettings {
  /**
   * How hard the engine may use the machine. `balanced` keeps Pixora
   * responsive while a job runs (the engine caps its worker threads at
   * the physical cores); `maximum` lets a long run claim every logical
   * processor — faster on an otherwise idle machine, at the cost of a
   * livelier computer while it works. Memory itself is never a user
   * knob: the engine sizes its own tiles from what the machine reports.
   */
  speed: 'balanced' | 'maximum'
}

export interface PixoraSettings {
  general: GeneralSettings
  processing: ProcessingSettings
  export: ExportSettings
  performance: PerformanceSettings
}

/** The settings format version on disk. Bumped only on a breaking change. */
export const SETTINGS_VERSION = 1

const SETTINGS_KEY = 'pixora:settings'
/** Where the last-opened view is remembered for `startupView: 'last'`.
 * Session data, not a preference — kept out of the settings record. */
const LAST_VIEW_KEY = 'pixora:last-view'
/** Retired per-feature keys, folded in once on first read (Stage 10). */
const LEGACY_THEME_KEY = 'pixora:theme'
const LEGACY_ENHANCE_KEY = 'pixora:enhance-settings'

export const DEFAULT_SETTINGS: PixoraSettings = {
  general: {
    theme: 'system',
    startupView: 'last',
    rememberRecentFiles: true,
    recentFilesLimit: 6,
  },
  processing: {
    defaultScale: 4,
    defaultMode: 'standard',
    enginePath: 'auto',
  },
  export: {
    format: 'png',
    quality: 90,
    folder: '',
  },
  performance: {
    speed: 'balanced',
  },
}

const VALID_SCALES = [2, 4]
const VALID_MODES: EnhanceModeKey[] = ['standard', 'natural', 'detail']
const VALID_FORMATS: ExportFormatKey[] = ['png', 'jpeg', 'webp']
const VALID_THEMES: ThemePreference[] = ['system', 'light', 'dark']
const VALID_STARTUP: StartupView[] = ['last', 'enhance', 'batch', 'history']
const VALID_ENGINE_PATHS: EnginePath[] = ['auto', 'cpu']
const VALID_SPEEDS: PerformanceSettings['speed'][] = ['balanced', 'maximum']

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asGroup(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {}
  return raw as Record<string, unknown>
}

/**
 * Fold a possibly-partial, possibly-nonsense stored object into a complete,
 * valid settings record. Every field independently falls back, so one bad
 * value costs one default — never the whole record.
 */
export function normalizeSettings(raw: unknown): PixoraSettings {
  const root = asGroup(raw)
  const general = asGroup(root.general)
  const processing = asGroup(root.processing)
  const exp = asGroup(root.export)
  const performance = asGroup(root.performance)
  const d = DEFAULT_SETTINGS

  return {
    general: {
      theme: pick(general.theme, VALID_THEMES, d.general.theme),
      startupView: pick(general.startupView, VALID_STARTUP, d.general.startupView),
      rememberRecentFiles: bool(general.rememberRecentFiles, d.general.rememberRecentFiles),
      recentFilesLimit: numberIn(
        general.recentFilesLimit,
        3,
        12, // the native store caps at 12; offering more would be a lie
        d.general.recentFilesLimit,
      ),
    },
    processing: {
      // A product scale the engine genuinely delivers, or the default —
      // 3× has never existed and never will.
      defaultScale: pick(processing.defaultScale, VALID_SCALES, d.processing.defaultScale),
      defaultMode: pick(processing.defaultMode, VALID_MODES, d.processing.defaultMode),
      enginePath: pick(processing.enginePath, VALID_ENGINE_PATHS, d.processing.enginePath),
    },
    export: {
      format: pick(exp.format, VALID_FORMATS, d.export.format),
      quality: numberIn(exp.quality, 1, 100, d.export.quality),
      // Only the native folder picker's answer is ever stored here, so a
      // string is trusted as-is; anything else falls back to the default.
      folder: text(exp.folder, d.export.folder),
    },
    performance: {
      speed: pick(performance.speed, VALID_SPEEDS, d.performance.speed),
    },
  }
}

/** The Stage 06 enhancement record (mode + scale), pre-Stage-10 shape. */
function readLegacyEnhance(): Partial<ProcessingSettings> {
  try {
    const raw = localStorage.getItem(LEGACY_ENHANCE_KEY)
    if (!raw) return {}
    const parsed = asGroup(JSON.parse(raw))
    const out: Partial<ProcessingSettings> = {}
    if (VALID_MODES.includes(parsed.mode as EnhanceModeKey)) {
      out.defaultMode = parsed.mode as EnhanceModeKey
    }
    if (VALID_SCALES.includes(parsed.scale as number)) {
      out.defaultScale = parsed.scale as number
    }
    return out
  } catch {
    return {}
  }
}

function readLegacyTheme(): ThemePreference | null {
  try {
    const stored = localStorage.getItem(LEGACY_THEME_KEY)
    return VALID_THEMES.includes(stored as ThemePreference) ? (stored as ThemePreference) : null
  } catch {
    return null
  }
}

function dropLegacyKeys() {
  try {
    localStorage.removeItem(LEGACY_THEME_KEY)
    localStorage.removeItem(LEGACY_ENHANCE_KEY)
  } catch {
    // Cleanup only; a failed removal is harmless (the read above already
    // preferred the new record).
  }
}

/**
 * Read persisted settings — safe in any environment (privacy mode, jsdom,
 * no storage at all) and never throws. A first run under Stage 10 migrates
 * the Stage 01–06 per-feature keys, then removes them.
 */
export function readSettings(): PixoraSettings {
  let stored: unknown = null
  let hadStored = false
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) {
      hadStored = true
      stored = JSON.parse(raw)
    }
  } catch {
    stored = null
  }
  const normalized = normalizeSettings(stored)
  if (hadStored) return normalized

  // Cold start under Stage 10: honour whatever the earlier stages stored,
  // field by field, and fold it into the new record.
  const legacyTheme = readLegacyTheme()
  const legacyEnhance = readLegacyEnhance()
  dropLegacyKeys()
  return normalizeSettings({
    general: { ...normalized.general, theme: legacyTheme ?? normalized.general.theme },
    processing: { ...normalized.processing, ...legacyEnhance },
  })
}

/** Write the full record. Fails silently by design: a preference that
 * cannot persist must not break the session that just changed it. */
export function writeSettings(settings: PixoraSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, ...settings }))
  } catch {
    // Storage unavailable — the in-memory state is still correct.
  }
}

/** Immutable patch of one group. Reducer and persistence share it; the
 * result is always a fully normalized record. */
export function patchSettings<K extends keyof PixoraSettings>(
  current: PixoraSettings,
  group: K,
  patch: Partial<PixoraSettings[K]>,
): PixoraSettings {
  return normalizeSettings({ ...current, [group]: { ...current[group], ...patch } })
}

/** The concrete views a cold start can land on (`last` resolves further). */
export type ConcreteView = 'enhance' | 'batch' | 'history'

/** Remembered view for `startupView: 'last'`; a stored value that is no
 * longer a real view (or no storage at all) lands on Enhance. */
export function readStoredLastView(): ConcreteView {
  try {
    const stored = localStorage.getItem(LAST_VIEW_KEY)
    if (stored === 'enhance' || stored === 'batch' || stored === 'history') return stored
  } catch {
    // Fall through to the default.
  }
  return 'enhance'
}

export function persistLastView(view: ConcreteView) {
  try {
    localStorage.setItem(LAST_VIEW_KEY, view)
  } catch {
    // Remembering a view must never break navigation.
  }
}

/** The view to open on a cold start, given settings + what was last used. */
export function resolveStartupView(settings: PixoraSettings): ConcreteView {
  if (settings.general.startupView === 'last') return readStoredLastView()
  return settings.general.startupView
}

/**
 * What the *native* side must know to honour these preferences: which
 * hardware path to take, how hard to use the machine, and whether
 * imported files should be remembered. Mirrored on every change (and at
 * startup); the native `settings.json` is a faithful copy of this
 * projection, nothing more.
 */
export interface EngineHints {
  cpuOnly: boolean
  fullPower: boolean
  recordRecents: boolean
}

export function toEngineHints(settings: PixoraSettings): EngineHints {
  return {
    cpuOnly: settings.processing.enginePath === 'cpu',
    fullPower: settings.performance.speed === 'maximum',
    recordRecents: settings.general.rememberRecentFiles,
  }
}
