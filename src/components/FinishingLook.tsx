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
 */
import { useId } from 'react'
import { useId } from 'react'
import type { FilterKey, FilterStatusDto } from '../types/ipc'
import { SelectField } from '../ui/Field'
import { cx } from '../ui/cx'
import { FILTER_DEFAULT_INTENSITY, FILTER_HINT, FILTER_LABEL, FILTER_ORDER } from '../lib/catalog'
import { PRESETS, type PresetKey } from '../lib/presets'
import './FinishingLook.css'

/** Labels and hints come from native whenever the status is there, so the
 * two surfaces can never call the same look two different names. */
export function availableFilterKeys(filters: FilterStatusDto[] | null): FilterKey[] {
  if (!filters) return FILTER_ORDER
  return filters
    .filter((f) => f.available)
    .map((f) => f.key as FilterKey)
    .filter((key) => FILTER_ORDER.includes(key))
}

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
  onPick: (key: PresetKey) => void
  className?: string
}

export function PresetChips({ active, keys, disabled = false, onPick, className }: PresetChipsProps) {
  const groupId = useId()
  const options = keys ? PRESETS.filter((p) => keys.includes(p.key)) : PRESETS
  const activePreset = options.find((p) => p.key === active) ?? null
  return (
    <div className={cx('pix-look__group', 'pix-look__group--preset', className)}>
      <span className="pix-field__label" id={groupId}>
        Preset
      </span>
      <div className="pix-look__chips" role="group" aria-labelledby={groupId}>
        {options.map((preset) => (
          <button
            key={preset.key}
            type="button"
            className={cx('pix-look__chip', preset.key === active && 'pix-look__chip--on')}
            aria-pressed={preset.key === active}
            disabled={disabled}
            onClick={() => onPick(preset.key)}
          >
            {preset.label}
          </button>
        ))}
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
  onChange: (patch: { filter?: FilterKey; intensity?: number }) => void
}

export function LookFields({
  filter,
  intensity,
  filters,
  disabled = false,
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
        {options.map((key) => (
          <option key={key} value={key}>
            {labelFor(filters, key)}
          </option>
        ))}
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
