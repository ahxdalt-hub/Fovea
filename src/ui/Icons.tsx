/**
 * Icon set — hand-drawn inline SVGs sized by tokens.
 *
 * Deliberately no icon library: the app needs a small fixed set and each
 * glyph is one path. Stroke follows currentColor so icons inherit control
 * state colors; sizes come from --icon-* tokens via the `size` prop.
 */
import type { SVGProps } from 'react'

export type IconSize = 'sm' | 'md' | 'lg'

const sizeVar: Record<IconSize, string> = {
  sm: 'var(--icon-sm)',
  md: 'var(--icon-md)',
  lg: 'var(--icon-lg)',
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'size'> {
  size?: IconSize
  /** Decorative by default: icon buttons carry their own accessible label. */
  label?: string
}

function Svg({ size = 'md', label, children, ...rest }: IconProps) {
  return (
    <svg
      width={sizeVar[size]}
      height={sizeVar[size]}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

/** Enhance: adjustment sliders — craft and precision, no "magic". */
export function IconTune(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 7h10M18 7h2" />
      <path d="M4 12h4M12 12h8" />
      <path d="M4 17h10M18 17h2" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="16" cy="17" r="2" />
    </Svg>
  )
}

/** Batch: stacked layers of files. */
export function IconLayers(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
      <path d="m4 12 8 4.2 8-4.2" />
      <path d="m4 16.5 8 4.2 8-4.2" />
    </Svg>
  )
}

/** History: clock with a rewind arrow. */
export function IconHistory(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 8.5A9 9 0 1 1 3 12" />
      <path d="M3 4v4.5h4.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  )
}

export function IconSettings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v2.6M12 18.6v2.6M4.5 7.2l2.3 1.3M17.2 15.5l2.3 1.3M4.5 16.8l2.3-1.3M17.2 8.5l2.3-1.3" />
    </Svg>
  )
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  )
}

export function IconMore(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Import: arrow into a tray. */
export function IconImport(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5v11m0 0 4-4m-4 4-4-4" />
      <path d="M4.5 17v1.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V17" />
    </Svg>
  )
}

/** Image placeholder glyph for the empty state. */
export function IconImage(props: IconProps) {
  return (
    <Svg {...props} strokeWidth="1.4">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 17.5 4.8-4.8 3.2 3.2 3-3 4 4.6" />
    </Svg>
  )
}

export function IconShield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 5 5.8v5.4c0 4.2 2.9 7.3 7 8.8 4.1-1.5 7-4.6 7-8.8V5.8L12 3Z" />
      <path d="m9 11.8 2.2 2.2L15.2 9.8" />
    </Svg>
  )
}

export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconWarning(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.8 2.8 20h18.4L12 3.8Z" />
      <path d="M12 10v4.5" />
      <circle cx="12" cy="17.2" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  )
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.8" />
      <path d="m8.3 12.2 2.6 2.6 4.8-5.4" />
    </Svg>
  )
}

export function IconRetry(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 12a8 8 0 1 1-2.4-5.7" />
      <path d="M20.5 3.5V8H16" />
    </Svg>
  )
}

export function IconKeyboard(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.8" y="6" width="18.4" height="12" rx="2" />
      <path d="M6.5 9.5h.01M10 9.5h.01M13.5 9.5h.01M17 9.5h.01M6.5 12.8h.01M10 12.8h.01M13.5 12.8h.01M17 12.8h.01M8 15.8h8" />
    </Svg>
  )
}

export function IconSun(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4" />
    </Svg>
  )
}

export function IconMoon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </Svg>
  )
}

export function IconMonitor(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="17" height="12" rx="1.8" />
      <path d="M9 20h6M12 16.5V20" />
    </Svg>
  )
}

export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 9.5 6 5.5 6-5.5" />
    </Svg>
  )
}
