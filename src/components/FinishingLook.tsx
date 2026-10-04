/**
 * Finishing-look fields (Stage 19) — the preset chips, the filter choice and
 * its strength, shared by the Enhance strip and the batch preset.
 *
 * Both surfaces ask the same question ("what should the result feel like?")
 * and must therefore offer the same words and the same math. What differs is
 * where the answer is *stored*: the strip writes the persisted processing
 * defaults, the batch view holds a per-run choice. That difference stays with
 * the caller — these components are pure presentation over a value and an
 * onChange.
 *
 * The controls describe real pixel work only. A chip highlights when the
 * strip's own four values genuinely equal that preset's, and the strength
 * knob is disabled (never hidden) for Original, which runs no pass at all.
 * A plan-locked choice follows the same rule (Stage 20): it stays on screen,
 * unselectable, with the plan that unlocks it named beside it.
 */
import { useId } from 'react'
import type { FilterKey, FilterStatusDto } from '../types/ipc'
import { SelectField } from '../ui/Field'
import { cx } from '../ui/cx'
import {
  availableFilterKeys,
  FILTER_DEFAULT_INTENSITY,
  FILTER_HINT,
  FILTER_LABEL,
} from '../lib/catalog'
import { planBadge, planName, type PlanTier } from '../lib/entitlements'
import { PRESETS, type Preset, type PresetKey } from '../lib/presets'
import './FinishingLook.css'

function labelFor(filters: FilterStatusDto[] | null, key: FilterKey): string {
  return filters?.find((f) => f.key === key)?.label ?? FILTER_LABEL[key]
}

function hintFor(filters: FilterStatusDto[] | null, key: FilterKey): string {
  return filters?.find((f) => f.key === key)?.description ?? FILTER_HINT[key]
}

export interface PresetChipsProps {
  /** The preset currently in effect, or `null` for a hand-tuned recipe. */
  active: PresetKey | null
  /** Filters the chips to the ones the engine can actually run. */
  keys?: PresetKey[]
  disabled?: boolean
  /** The plan a preset needs, or `null` when this one can run it. A locked
   * chip is drawn and named, never removed — the free plan's 4× is a real
   * thing the user can see they are missing. */
  lockFor?: (preset: Preset) => PlanTier | null
  onPick: (key: PresetKey) => void
  className?: string
}

export function PresetChips({
  active,
  keys,
  disabled = false,
  lockFor,
  onPick,
  className,
}: PresetChipsProps) {
  const groupId = useId()
  const options = keys ? PRESETS.filter((p) => keys.includes(p.key)) : PRESETS
  const activePreset = options.find((p) => p.key === active) ?? null
  return (
    <div className={cx('pix-look__group', 'pix-look__group--preset', className)}>
      <span className="pix-field__label" id={groupId}>
        Preset
      </span>
      <div className="pix-look__chips" role="group" aria-labelledby={groupId}>
        {options.map((preset) => {
          const tier = lockFor?.(preset) ?? null
          return (
            <button
              key={preset.key}
              type="button"
              className={cx(
                'pix-look__chip',
                preset.key === active && 'pix-look__chip--on',
                tier !== null && 'pix-look__chip--locked',
              )}
              aria-pressed={preset.key === active}
              disabled={disabled || tier !== null}
              title={tier === null ? preset.hint : `${preset.label} needs ${planName(tier)}`}
              onClick={() => onPick(preset.key)}
            >
              {preset.label}
              {tier !== null ? (
                <span className="pix-look__chip-badge">{planBadge(tier)}</span>
              ) : null}
            </button>
          )
        })}
      </div>
      <p className="pix-field__message">
        {activePreset
          ? `${activePreset.label}: ${activePreset.hint}`
          : 'Custom — these settings are your own, kept as your defaults'}
      </p>
    </div>
  )
}

export interface LookFieldsProps {
  filter: FilterKey
  intensity: number
  /** The native filter list, or `null` before the first status arrives. */
  filters: FilterStatusDto[] | null
  disabled?: boolean
  /** The plan a look needs, or `null` when this plan can run it. Portrait is
   * the one filter with a face-detection pass behind it, so it is the one a
   * plan can hold back. */
  lockFor?: (filter: FilterKey) => PlanTier | null
  onChange: (patch: { filter?: FilterKey; intensity?: number }) => void
}

export function LookFields({
  filter,
  intensity,
  filters,
  disabled = false,
  lockFor,
  onChange,
}: LookFieldsProps) {
  const options = availableFilterKeys(filters)
  const off = filter === 'original'
  const sliderId = useId()
  return (
    <>
      <SelectField
        className="pix-look__group"
        label="Look"
        name="fovea-filter"
        value={filter}
        onChange={(event) => onChange({ filter: event.target.value as FilterKey })}
        disabled={disabled}
        hint={hintFor(filters, filter)}
      >
        {options.map((key) => {
          const tier = lockFor?.(key) ?? null
          return (
            <option key={key} value={key} disabled={tier !== null}>
              {tier === null
                ? labelFor(filters, key)
                : `${labelFor(filters, key)} — ${planBadge(tier)}`}
            </option>
          )
        })}
      </SelectField>

      <div className={cx('pix-field pix-look__group', off && 'pix-look__group--off')}>
        <label className="pix-field__label pix-look__value-row" htmlFor={sliderId}>
          <span>Strength</span>
          <span className="u-tabular">{off ? 'off' : intensity}</span>
        </label>
        <input
          id={sliderId}
          className="pix-range"
          type="range"
          min={0}
          max={100}
          step={5}
          value={intensity}
          // Original runs no pass, so the knob is genuinely inert — shown
          // disabled, never hidden, so the reason stays on screen.
          disabled={disabled || off}
          onChange={(event) => onChange({ intensity: Number(event.target.value) })}
        />
        <p className="pix-field__message">
          {off
            ? 'Original adds nothing — the model result is the picture.'
            : `0 leaves the result untouched, ${FILTER_DEFAULT_INTENSITY} is how the look was designed, 100 is full strength.`}
        </p>
      </div>
    </>
  )
}
