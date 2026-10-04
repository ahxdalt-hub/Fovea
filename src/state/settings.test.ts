/**
 * Settings (Stage 10) — the contract that makes persistence trustworthy:
 * defaults are what the UI says they are, garbage normalizes field by
 * field, legacy keys migrate exactly once, and a write/read round trip
 * (the "restart the app" case in a test) returns what was stored.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  patchSettings,
  persistLastView,
  readSettings,
  readStoredLastView,
  resolveStartupView,
  SETTINGS_VERSION,
  toEngineHints,
  writeSettings,
} from './settings'

const SETTINGS_KEY = 'fovea:settings'
const LEGACY_THEME_KEY = 'fovea:theme'
const LEGACY_ENHANCE_KEY = 'fovea:enhance-settings'

beforeEach(() => {
  localStorage.clear()
})

describe('defaults', () => {
  it('start on the safe, recommended values', () => {
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('normalizeSettings', () => {
  it('survives total nonsense', () => {
    for (const junk of [undefined, null, 7, 'str', [], true]) {
      expect(normalizeSettings(junk)).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('falls back per field, not per record', () => {
    const got = normalizeSettings({
      general: { theme: 'hot-pink', rememberRecentFiles: 'yes', recentFilesLimit: 4000 },
      processing: { defaultScale: 3, defaultMode: 'standard', enginePath: 'moon' },
      export: { format: 'tiff', quality: 190, folder: 42 },
      performance: { speed: 'turbo' },
    })
    expect(got.general.theme).toBe('light') // junk → default
    expect(got.general.rememberRecentFiles).toBe(true) // junk → default
    expect(got.general.recentFilesLimit).toBe(12) // clamped to the native cap
    expect(got.processing.defaultScale).toBe(4) // 3 is not a product scale
    expect(got.processing.defaultMode).toBe('standard') // the good value stands
    expect(got.processing.enginePath).toBe('auto')
    expect(got.export.format).toBe('png')
    expect(got.export.quality).toBe(100) // clamped into range
    expect(got.export.folder).toBe('') // non-strings never claim a path
    expect(got.performance.speed).toBe('balanced')
  })

  it('accepts a complete valid record untouched', () => {
    const full = {
      general: {
        theme: 'dark',
        startupView: 'batch',
        rememberRecentFiles: false,
        recentFilesLimit: 9,
      },
      processing: {
        defaultScale: 2,
        defaultMode: 'detail',
        defaultFilter: 'original',
        defaultIntensity: 50,
        enginePath: 'cpu',
      },
      export: { format: 'webp', quality: 82, folder: 'D:/Exports' },
      performance: { speed: 'maximum' },
    }
    expect(normalizeSettings(full)).toEqual(full)
  })
})

describe('persistence (the restart case)', () => {
  it('writes and reads back the same record', () => {
    const next = patchSettings(
      patchSettings(DEFAULT_SETTINGS, 'general', { theme: 'dark' }),
      'export',
      { format: 'jpeg', quality: 75, folder: 'D:/Out' },
    )
    writeSettings(next)
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')
    expect(stored.version).toBe(SETTINGS_VERSION)
    expect(readSettings()).toEqual(next)
  })

  it('normalizes on read, so a hand-edited file cannot poison the session', () => {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ version: SETTINGS_VERSION, general: { theme: 'neon' } }),
    )
    expect(readSettings().general.theme).toBe('light')
  })

  it('treats a corrupt file as no file at all', () => {
    localStorage.setItem(SETTINGS_KEY, '{truncated')
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it('never throws when storage itself is unavailable', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('privacy mode')
    }
    try {
      expect(readSettings()).toEqual(DEFAULT_SETTINGS)
    } finally {
      Storage.prototype.getItem = original
    }
    const originalSet = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('quota')
    }
    try {
      expect(() => writeSettings(DEFAULT_SETTINGS)).not.toThrow()
    } finally {
      Storage.prototype.setItem = originalSet
    }
  })
})

describe('legacy migration (Stages 01–06 keys)', () => {
  it('folds the old theme and enhancement keys into the record once', () => {
    localStorage.setItem(LEGACY_THEME_KEY, 'dark')
    localStorage.setItem(LEGACY_ENHANCE_KEY, JSON.stringify({ mode: 'natural', scale: 2 }))
    const got = readSettings()
    expect(got.general.theme).toBe('dark')
    expect(got.processing.defaultMode).toBe('natural')
    expect(got.processing.defaultScale).toBe(2)
    // Retired: the legacy keys are gone, so the new record is the only
    // answer from here on.
    expect(localStorage.getItem(LEGACY_THEME_KEY)).toBeNull()
    expect(localStorage.getItem(LEGACY_ENHANCE_KEY)).toBeNull()
  })

  it('ignores junk in legacy keys', () => {
    localStorage.setItem(LEGACY_THEME_KEY, 'blueprint')
    localStorage.setItem(LEGACY_ENHANCE_KEY, '{"mode":"laser","scale":9}')
    const got = readSettings()
    expect(got.general.theme).toBe('light')
    expect(got.processing.defaultMode).toBe('standard')
    expect(got.processing.defaultScale).toBe(4)
  })

  it('prefers the new record over legacy leftovers', () => {
    localStorage.setItem(LEGACY_THEME_KEY, 'dark')
    writeSettings(patchSettings(DEFAULT_SETTINGS, 'general', { theme: 'light' }))
    expect(readSettings().general.theme).toBe('light')
  })
})

describe('patchSettings', () => {
  it('changes one group and leaves the rest intact', () => {
    const before = readSettings()
    const after = patchSettings(before, 'processing', { defaultScale: 2 })
    expect(after.processing.defaultScale).toBe(2)
    expect(after.general).toEqual(before.general)
    expect(after.export).toEqual(before.export)
  })

  it('normalizes the patched value (2.5× is not a scale)', () => {
    const after = patchSettings(DEFAULT_SETTINGS, 'processing', { defaultScale: 2.5 })
    // 2.5 rounds into [2,4] as 3 → not a product scale → default.
    expect(after.processing.defaultScale).toBe(DEFAULT_SETTINGS.processing.defaultScale)
  })
})

describe('startup view', () => {
  it('resolves "last" from the remembered view, defaulting to Enhance', () => {
    const lastIs = patchSettings(DEFAULT_SETTINGS, 'general', { startupView: 'last' })
    expect(resolveStartupView(lastIs)).toBe('enhance')
    persistLastView('batch')
    expect(resolveStartupView(lastIs)).toBe('batch')
    expect(readStoredLastView()).toBe('batch')
  })

  it('uses a concrete view directly, without consulting memory', () => {
    persistLastView('history')
    expect(resolveStartupView(DEFAULT_SETTINGS)).toBe('history')
    const pinned = patchSettings(DEFAULT_SETTINGS, 'general', { startupView: 'enhance' })
    expect(resolveStartupView(pinned)).toBe('enhance')
  })

  it('ignores a remembered value that names no real view', () => {
    localStorage.setItem('fovea:last-view', 'settings')
    expect(readStoredLastView()).toBe('enhance')
  })
})

describe('toEngineHints', () => {
  it('projects exactly what native must honour', () => {
    expect(toEngineHints(DEFAULT_SETTINGS)).toEqual({
      cpuOnly: false,
      fullPower: false,
      recordRecents: true,
    })
    const forced = patchSettings(
      patchSettings(
        patchSettings(DEFAULT_SETTINGS, 'processing', { enginePath: 'cpu' }),
        'performance',
        { speed: 'maximum' },
      ),
      'general',
      { rememberRecentFiles: false },
    )
    expect(toEngineHints(forced)).toEqual({
      cpuOnly: true,
      fullPower: true,
      recordRecents: false,
    })
  })
})
