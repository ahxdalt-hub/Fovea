/**
 * Form controls — TextField and SelectField.
 *
 * Native <select> is used deliberately: it is fast, accessible, and
 * themeable enough in WebView2. A custom listbox returns only if a future
 * stage needs rich options.
 */
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react'
import { cx } from './cx'
import { IconChevronDown } from './Icons'
import './Field.css'

interface FieldShellProps {
  label: string
  hint?: string
  error?: string
  controlId: string
  children: ReactNode
  className?: string
}

function FieldShell({ label, hint, error, controlId, children, className }: FieldShellProps) {
  return (
    <div className={cx('pix-field', className)}>
      <label className="pix-field__label" htmlFor={controlId}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="pix-field__message pix-field__message--error" id={`${controlId}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="pix-field__message" id={`${controlId}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string
  hint?: string
  error?: string
  className?: string
}

export function TextField({ label, hint, error, className, ...rest }: TextFieldProps) {
  const id = useId()
  return (
    <FieldShell label={label} hint={hint} error={error} controlId={id} className={className}>
      <input
        id={id}
        className={cx('pix-input', error && 'pix-input--invalid')}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
        {...rest}
      />
    </FieldShell>
  )
}

export interface SelectFieldProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className'
> {
  label: string
  hint?: string
  error?: string
  className?: string
}

export function SelectField({
  label,
  hint,
  error,
  className,
  children,
  ...rest
}: SelectFieldProps) {
  const id = useId()
  return (
    <FieldShell label={label} hint={hint} error={error} controlId={id} className={className}>
      <span className="pix-select-wrap">
        <select
          id={id}
          className={cx('pix-select', error && 'pix-select--invalid')}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          {...rest}
        >
          {children}
        </select>
        <IconChevronDown size="sm" className="pix-select__chevron" />
      </span>
    </FieldShell>
  )
}

/** Segmented radio group — for small, either/or choices (≤4 options). */
export interface SegmentedFieldProps {
  label: string
  value: string
  options: Array<{ value: string; label: string; icon?: ReactNode }>
  onChange: (value: string) => void
  name?: string
  className?: string
  /** Locks the whole group (e.g. while a job is running). */
  disabled?: boolean
  hint?: string
}

export function SegmentedField({
  label,
  value,
  options,
  onChange,
  name,
  className,
  disabled = false,
  hint,
}: SegmentedFieldProps) {
  const groupName = useId()
  return (
    <div className={cx('pix-segmented', className)} role="group" aria-label={label}>
      <span className="pix-field__label">{label}</span>
      <div className="pix-segmented__track">
        {options.map((option) => (
          <label
            key={option.value}
            className={cx(
              'pix-segmented__option',
              value === option.value && 'pix-segmented__option--checked',
              disabled && 'pix-segmented__option--disabled',
            )}
          >
            <input
              type="radio"
              name={name ?? groupName}
              className="u-visually-hidden"
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            {option.icon}
            {option.label}
          </label>
        ))}
      </div>
      {hint && <span className="pix-field__message">{hint}</span>}
    </div>
  )
}

/** Switch row — one persistent yes/no preference (Stage 10 settings).
 * A real checkbox carries semantics and keyboard support; the track is
 * pure styling, so the control behaves everywhere the rest of the app
 * does. The whole row is clickable, which is what users actually aim at. */
export interface ToggleFieldProps {
  label: string
  /** Plain-language sentence shown under the label — what turning this
   * off actually does. */
  description?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

export function ToggleField({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  className,
}: ToggleFieldProps) {
  const id = useId()
  return (
    <div className={cx('pix-toggle', disabled && 'pix-toggle--disabled', className)}>
      <label className="pix-toggle__row" htmlFor={id}>
        <span className="pix-toggle__copy">
          <span className="pix-toggle__label">{label}</span>
          {description && <span className="pix-field__message">{description}</span>}
        </span>
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="u-visually-hidden"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="pix-toggle__track" aria-hidden="true">
          <span className="pix-toggle__knob" />
        </span>
      </label>
    </div>
  )
}
