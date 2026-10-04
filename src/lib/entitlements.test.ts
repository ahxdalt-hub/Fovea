/**
 * Entitlement table (Stage 20). The point of this module is that it mirrors
 * `services/license` rather than re-deciding policy, so the tests are written
 * against capability lists exactly as the native status emits them: if the
 * two tables drift, a tier record stops unlocking what it should, and these
 * assertions go red.
 */
import { describe, expect, it } from 'vitest'
import type { LicenseStatusDto } from '../types/ipc'
import { PRESETS } from './presets'
import type { FoveaSettings } from '../state/settings'
import {
  FREE_MAX_SCALE,
  filterLock,
  hasRepairs,
  modeLock,
  periodLabel,
  planBadge,
  planLock,
  planName,
  planQuota,
  planRepairs,
  planScaleCeiling,
  planView,
  presetLock,
  scaleLock,
  type Capability,
} from './entitlements'

// Exactly the three rows Rust `capabilities_for` can produce, in
// `ALL_FEATURES` order. Native is the thing being mirrored here.
const FREE: Capability[] = ['enhance', 'export', 'batch', 'journal']
const PRO: Capability[] = [
  ...FREE,
  'upscale_4x',
  'advanced_restoration',
  'face_enhancement',
  'unlimited_processing',
]
const STUDIO: Capability[] = [...PRO, 'engine_controls']

function record(over: Partial<LicenseStatusDto>): LicenseStatusDto {
  return {
    state: 'active',
    edition: 'pro',
    holder: 'ada@example.com',
    licenseId: 'PL-1',
    issuedAt: 1,
    expiresAt: null,
    activatedAt: 2,
    machineBound: false,
    capabilities: PRO,
    machineHint: 'abcd1234',
    quota: null,
    ...over,
  }
}

const free = planView(record({ state: 'not_activated', edition: null, capabilities: FREE }))
const pro = planView(record({ capabilities: PRO }))
const studio = planView(record({ edition: 'studio', capabilities: STUDIO }))
// The license has not been read yet — a different situation from the free plan.
const unknown = planView(null)

describe('the plan in force', () => {
  it('reports an unread license as unknown, never as the free plan', () => {
    expect(unknown.known).toBe(false)
    expect(planScaleCeiling(unknown)).toBeNull()
    expect(planQuota(unknown)).toBeNull()
    for (const capability of ['upscale_4x', 'engine_controls'] as Capability[]) {
      expect(planLock(unknown, capability)).toBeNull()
    }
  })

  it('lands every lapsed or untrusted key on the free plan', () => {
    for (const state of [
      'expired',
      'wrong_machine',
      'tampered',
      'revoked',
      'clock_suspect',
    ] as const) {
      const plan = planView(record({ state, edition: 'pro', capabilities: FREE }))
      expect(plan.known).toBe(true)
      expect(plan.tier).toBe('free')
      expect(scaleLock(plan, 4)).toBe('pro')
    }
  })

  it('names the plans the way Rust `plan_for` names them', () => {
    expect(planName('pro')).toBe('Fovea Pro')
    expect(planName('studio')).toBe('Fovea Studio')
    expect(planBadge('pro')).toBe('Pro')
    expect(planBadge('studio')).toBe('Studio')
  })
})

describe('the capability table mirrors the native one', () => {
  it('a free record locks exactly the five capabilities the paid plans add', () => {
    expect(planLock(free, 'upscale_4x')).toBe('pro')
    expect(planLock(free, 'advanced_restoration')).toBe('pro')
    expect(planLock(free, 'face_enhancement')).toBe('pro')
    expect(planLock(free, 'unlimited_processing')).toBe('pro')
    expect(planLock(free, 'engine_controls')).toBe('studio')
  })

  it('the free baseline unlocks nothing it already grants', () => {
    for (const capability of FREE) {
      expect(planLock(free, capability)).toBeNull()
      expect(planLock(pro, capability)).toBeNull()
      expect(planLock(studio, capability)).toBeNull()
    }
  })

  it('Pro opens the processing features but not the machine controls', () => {
    for (const capability of PRO) {
      expect(planLock(pro, capability)).toBeNull()
    }
    expect(planLock(pro, 'engine_controls')).toBe('studio')
  })

  it('Studio opens the whole table', () => {
    for (const capability of STUDIO) {
      expect(planLock(studio, capability)).toBeNull()
    }
  })
})

describe('the questions a control asks', () => {
  it('caps the free plan at the native ceiling', () => {
    expect(planScaleCeiling(free)).toBe(FREE_MAX_SCALE)
    expect(planScaleCeiling(pro)).toBeNull()
    expect(scaleLock(free, 2)).toBeNull()
    expect(scaleLock(free, 4)).toBe('pro')
    expect(scaleLock(pro, 4)).toBeNull()
  })

  it('holds Standard free and the other two restorations for Pro', () => {
    expect(modeLock(free, 'standard')).toBeNull()
    expect(modeLock(free, 'natural')).toBe('pro')
    expect(modeLock(free, 'detail')).toBe('pro')
    expect(modeLock(pro, 'natural')).toBeNull()
  })

  it('locks Portrait and no other look', () => {
    expect(filterLock(free, 'portrait')).toBe('pro')
    for (const filter of ['original', 'natural', 'soft', 'product', 'vivid'] as const) {
      expect(filterLock(free, filter)).toBeNull()
    }
    expect(filterLock(studio, 'portrait')).toBeNull()
  })

  it('a preset needs the most demanding plan of its parts', () => {
    const locked = PRESETS.filter((p) => presetLock(free, p) !== null).map((p) => p.key)
    expect(locked.length).toBeGreaterThan(0)
    for (const preset of PRESETS) {
      const lock = presetLock(free, preset)
      // A free-plan lock on a preset can only ever be worth Pro: no preset
      // touches the hardware knobs.
      expect(lock === null || lock === 'pro').toBe(true)
      // Nothing a Pro record can run is left locked.
      expect(presetLock(pro, preset)).toBeNull()
    }
    // Exactly the recipes that reach for a Pro part: the 4× ceiling, a
    // restoration beyond Standard, or the Portrait look.
    expect(new Set(locked)).toEqual(
      new Set(
        PRESETS.filter(
          (p) =>
            p.processing.scale > FREE_MAX_SCALE ||
            p.processing.mode !== 'standard' ||
            p.processing.filter === 'portrait',
        ).map((p) => p.key),
      ),
    )
  })
})

describe('a stored preference the plan cannot honour', () => {
  const settings = {
    processing: { enginePath: 'gpu', scale: 4, mode: 'detail', filter: 'portrait' },
    performance: { speed: 'maximum' },
  } as unknown as FoveaSettings

  it('returns the hardware knobs to their defaults off a Studio plan', () => {
    const repairs = planRepairs(free, settings)
    expect(hasRepairs(repairs)).toBe(true)
    expect(repairs.processing).toEqual({ enginePath: 'auto' })
    expect(repairs.performance).toEqual({ speed: 'balanced' })
  })

  it('leaves a Pro run alone — the machine controls are Studio, but paid', () => {
    expect(hasRepairs(planRepairs(pro, settings))).toBe(true)
    expect(hasRepairs(planRepairs(studio, settings))).toBe(false)
    expect(hasRepairs(planRepairs(unknown, settings))).toBe(false)
  })
})

describe('the month meter', () => {
  it('shows a free plan its own numbers', () => {
    const quota = { period: '2026-10', limit: 10, used: 3, remaining: 7 }
    const plan = planView(record({ state: 'not_activated', capabilities: FREE, quota }))
    expect(planQuota(plan)).toEqual(quota)
    expect(planQuota(pro)).toBeNull()
  })

  it('spells a period without a Date', () => {
    expect(periodLabel('2026-10')).toBe('October 2026')
    expect(periodLabel('2027-01')).toBe('January 2027')
    expect(periodLabel('nonsense')).toBe('nonsense')
  })
})
