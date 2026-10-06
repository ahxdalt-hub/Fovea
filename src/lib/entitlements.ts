/**
 * The plan in force, in UI words (Stage 20).
 *
 * Native is authoritative: `services/license` decides what a plan allows and
 * every working command enforces it. This module is the *same table* read the
 * other way round — it exists so a control can be drawn disabled with the
 * name of the plan that unlocks it, instead of looking enabled and refusing
 * later. That is the product's rule: a locked option is shown, never hidden.
 *
 * Two deliberate properties:
 *
 * - **One table.** `REQUIRED` mirrors Rust `minimum_edition` exactly. The
 *   license status carries the native capability list, so the UI renders the
 *   plan it was *given* rather than a second copy of the policy; the table
 *   only translates a capability into the tier to name on screen. A test
 *   compares the two against a real Pro and Studio record, so the tables
 *   cannot drift silently.
 * - **Unknown is not free.** Before the first license status arrives the view
 *   reports no locks and no ceiling. Reading `null` as "free plan" would flash
 *   paywall badges at a Pro user on every start, and — worse — let a startup
 *   repair write 2× over a perfectly good stored 4×.
 */
import type { EnhanceModeKey, FilterKey, LicenseQuotaDto, LicenseStatusDto } from '../types/ipc'
import type { FoveaSettings, PerformanceSettings, ProcessingSettings } from '../state/settings'
import type { Preset } from './presets'

/** The largest upscale the free plan runs — mirrors Rust `FREE_MAX_SCALE`. */
export const FREE_MAX_SCALE = 2

/** Capability keys native emits, exactly as Rust `Feature::as_str` spells
 * them. Anything the free plan already grants is listed with `null`. */
export type Capability =
  | 'enhance'
  | 'export'
  | 'batch'
  | 'journal'
  | 'upscale_4x'
  | 'advanced_restoration'
  | 'face_enhancement'
  | 'unlimited_processing'
  | 'engine_controls'

/** The paid plans, in ascending order. A lock always names one. */
export type PlanTier = 'pro' | 'studio'

const TIER_RANK: Record<'free' | PlanTier, number> = { free: 0, pro: 1, studio: 2 }

/** The cheapest plan that includes a capability, or `null` when the free plan
 * already does. The whole commercial policy, as one table. */
const REQUIRED: Record<Capability, PlanTier | null> = {
  enhance: null,
  export: null,
  batch: null,
  journal: null,
  upscale_4x: 'pro',
  advanced_restoration: 'pro',
  face_enhancement: 'pro',
  unlimited_processing: 'pro',
  engine_controls: 'studio',
}

/** What a lock is worth to the user, as it appears on a control. */
const TIER_BADGE: Record<PlanTier, string> = { pro: 'Pro', studio: 'Studio' }

/** One row of the "what each plan runs" table, in native's policy order
 * (`ALL_FEATURES` in `services/license`). The `capability` key is what the
 * cell's value is *computed* from — this list carries no ✓ marks of its own,
 * so the table cannot claim something the gate does not grant.
 *
 * `detail` earns its vertical space only on a row the plans disagree about,
 * so the four baseline rows carry none. */
export interface PlanRow {
  readonly capability: Capability
  readonly label: string
  readonly detail?: string
  /** True for the row whose free-plan answer is the monthly count, which
   * only native knows the size of. */
  readonly metered?: boolean
}

export const PLAN_ROWS: readonly PlanRow[] = [
  { capability: 'enhance', label: 'Enhance images' },
  { capability: 'export', label: 'Export results' },
  { capability: 'batch', label: 'Batch a folder' },
  { capability: 'journal', label: 'History journal' },
  { capability: 'upscale_4x', label: '4× upscaling', detail: 'Above the free plan’s 2× ceiling' },
  {
    capability: 'advanced_restoration',
    label: 'Natural and Detail models',
    detail: 'Denoise-first, and the sharpening pass',
  },
  {
    capability: 'face_enhancement',
    label: 'Portrait finishing look',
    detail: 'The one look tuned for skin',
  },
  {
    capability: 'unlimited_processing',
    label: 'Unlimited processing',
    detail: 'The free plan counts a monthly allowance',
    metered: true,
  },
  {
    capability: 'engine_controls',
    label: 'Hardware path and power mode',
    detail: 'Force the processor, or use every core',
  },
]

/** Does a plan carry a capability? Computed from `REQUIRED`, which mirrors
 * Rust `minimum_edition` — so the table, the badges on locked controls and
 * the native gate are three readings of one policy. */
export function planGrants(tier: 'free' | PlanTier, capability: Capability): boolean {
  const needed = REQUIRED[capability]
  return needed === null || TIER_RANK[tier] >= TIER_RANK[needed]
}

/** Ascending order of the plans, for "does this build outrank that record?" */
export function tierRank(tier: 'free' | PlanTier): number {
  return TIER_RANK[tier]
}

export interface PlanView {
  /** False until the native license status has arrived. */
  readonly known: boolean
  /** The plan running on this machine. `free` covers an unactivated app and a
   * lapsed or revoked key alike — both genuinely get the free plan. */
  readonly tier: 'free' | PlanTier
  /** Capabilities native listed for this plan. */
  readonly capabilities: ReadonlySet<string>
  /** The month's meter, or `null` when there is nothing to count. */
  readonly quota: LicenseQuotaDto | null
}

/** Read the license status into a plan view. `null` (not fetched yet, or the
 * license record could not be read) is reported as *unknown*, not as the free
 * plan — see the module doc. */
export function planView(license: LicenseStatusDto | null): PlanView {
  const edition = license?.edition ?? null
  const tier: PlanView['tier'] =
    license !== null && license.state === 'active' && (edition === 'pro' || edition === 'studio')
      ? edition
      : 'free'
  return {
    known: license !== null,
    tier,
    capabilities: new Set(license?.capabilities ?? []),
    quota: license?.quota ?? null,
  }
}

/** The plan a capability needs, or `null` when the plan in force already has
 * it. An unknown plan locks nothing.
 *
 * Native's capability list decides *whether*; this module's table only names
 * *which plan* to show. So a capability listed by native is never locked here,
 * even if the table below is a version behind.
 */
export function planLock(plan: PlanView, capability: Capability): PlanTier | null {
  if (!plan.known) return null
  if (plan.capabilities.has(capability)) return null
  const needed = REQUIRED[capability]
  if (needed === null) return null
  return TIER_RANK[plan.tier] >= TIER_RANK[needed] ? null : needed
}

/** The short word on a locked control. */
export function planBadge(tier: PlanTier): string {
  return TIER_BADGE[tier]
}

/** The plan's product name, for a sentence. Mirrors Rust `plan_for`. */
export function planName(tier: PlanTier): string {
  return tier === 'pro' ? 'Fovea Pro' : 'Fovea Studio'
}

/** The most an upscale factor can be on this plan, or `null` for no ceiling
 * (an unlimited plan, or a plan not yet read). */
export function planScaleCeiling(plan: PlanView): number | null {
  if (!plan.known) return null
  return plan.capabilities.has('upscale_4x') ? null : FREE_MAX_SCALE
}

/** The monthly meter, or `null` when this plan is not metered. */
export function planQuota(plan: PlanView): LicenseQuotaDto | null {
  return plan.known ? plan.quota : null
}

/** Does this install still owe itself one conversation with the meter? The
 * count lives on Fovea's server, so an install that has never reached it has
 * no balance — it has a shape. Showing `10 of 10` there would promise ten
 * enhancements and then refuse the first one. */
export function meterUncounted(quota: LicenseQuotaDto | null): boolean {
  return quota !== null && !quota.counted
}

/** The month as one line, in the words the strip and the batch queue share.
 * Three states, and only the middle one is a countdown. */
export function meterLine(quota: LicenseQuotaDto): string {
  if (!quota.counted) {
    return `The free plan allows ${quota.limit} enhancements a month — one internet connection sets this month’s count up`
  }
  if (quota.remaining <= 0) {
    return `All ${quota.limit} free enhancements used in ${periodLabel(quota.period)}`
  }
  return `${quota.remaining} of ${quota.limit} free enhancements left in ${periodLabel(quota.period)}`
}

/** A stored preference the plan in force cannot honour, as the patch that
 * makes it honourable. Empty when nothing needs fixing.
 *
 * Only the hardware knobs live here. The strip's scale / mode / filter depend
 * on which models are installed as well as on the plan, so those are healed
 * where the engine status is known (`EnhanceControls`). The hardware switches
 * do not: `settings.json` outlives the plan that wrote it, so a lapsed Studio
 * would otherwise keep a forced-processor path that native refuses to run —
 * and a Settings page describing an engine path that isn't happening is a
 * lie on screen, not a locked control. */
export interface PlanRepairs {
  processing: Partial<ProcessingSettings>
  performance: Partial<PerformanceSettings>
}

export function planRepairs(plan: PlanView, settings: FoveaSettings): PlanRepairs {
  const engineLocked = planLock(plan, 'engine_controls') !== null
  const repairs: PlanRepairs = { processing: {}, performance: {} }
  if (engineLocked && settings.processing.enginePath !== 'auto') {
    repairs.processing.enginePath = 'auto'
  }
  if (engineLocked && settings.performance.speed !== 'balanced') {
    repairs.performance.speed = 'balanced'
  }
  return repairs
}

export function hasRepairs(repairs: PlanRepairs): boolean {
  return Object.keys(repairs.processing).length > 0 || Object.keys(repairs.performance).length > 0
}

export function capabilityForScale(scale: number): Capability | null {
  return scale > FREE_MAX_SCALE ? 'upscale_4x' : null
}

export function capabilityForMode(mode: EnhanceModeKey): Capability | null {
  return mode === 'standard' ? null : 'advanced_restoration'
}

/** Portrait is the one look that does real face work, so it is the one filter
 * a plan can hold back. */
export function capabilityForFilter(filter: FilterKey): Capability | null {
  return filter === 'portrait' ? 'face_enhancement' : null
}

/** A preset spans several controls; it needs the most demanding of them. */
export function capabilityForPreset(preset: Preset): Capability | null {
  const parts = [
    capabilityForScale(preset.processing.scale),
    capabilityForMode(preset.processing.mode),
    capabilityForFilter(preset.processing.filter),
  ]
  return parts.reduce<Capability | null>(
    (worst, part) =>
      part === null ? worst : worst === null ? part : rankOf(part) > rankOf(worst) ? part : worst,
    null,
  )
}

/** The meter charges every capability of the same tier, so ordering by tier
 * is enough: the highest tier a recipe touches is what locks it. */
function rankOf(capability: Capability): number {
  const needed = REQUIRED[capability]
  return needed === null ? 0 : TIER_RANK[needed]
}

/** ── The four questions a control asks: can this plan run *this* choice?
 * Each returns the plan to name on screen, or `null` when the choice is
 * already the plan's to make. */

export function scaleLock(plan: PlanView, scale: number): PlanTier | null {
  const capability = capabilityForScale(scale)
  return capability === null ? null : planLock(plan, capability)
}

export function modeLock(plan: PlanView, mode: EnhanceModeKey): PlanTier | null {
  const capability = capabilityForMode(mode)
  return capability === null ? null : planLock(plan, capability)
}

export function filterLock(plan: PlanView, filter: FilterKey): PlanTier | null {
  const capability = capabilityForFilter(filter)
  return capability === null ? null : planLock(plan, capability)
}

export function presetLock(plan: PlanView, preset: Preset): PlanTier | null {
  const capability = capabilityForPreset(preset)
  return capability === null ? null : planLock(plan, capability)
}

/** `'2026-11'` → `'November'` — spelled here rather than through `Date`, so a
 * month label can never shift a day (or a month) with the local timezone. */
export function periodLabel(period: string): string {
  const [year, month] = period.split('-')
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ]
  const index = Number(month) - 1
  const name = names[index]
  if (!year || !name) return period
  return `${name} ${year}`
}
