/**
 * BrandMark — the Pixora glyph (from assets/app-icon.svg), simplified for
 * small sizes. Always paired with the wordmark in the top bar.
 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
      focusable="false"
      className="pixora-brand-mark"
    >
      <rect width="1024" height="1024" rx="192" fill="#1d2733" />
      <rect
        x="224"
        y="224"
        width="352"
        height="352"
        rx="36"
        fill="none"
        stroke="#5b7a99"
        strokeWidth="28"
      />
      <rect x="448" y="448" width="352" height="352" rx="36" fill="#e8edf2" />
      <path d="M512 736 L612 600 L680 680 L732 620 L800 736 Z" fill="#1d2733" />
      <circle cx="740" cy="528" r="34" fill="#1d2733" />
      <path d="M836 188 v96 M788 236 h96" stroke="#c8d4e0" strokeWidth="30" strokeLinecap="round" />
    </svg>
  )
}
