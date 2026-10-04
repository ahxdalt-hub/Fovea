/**
 * BrandMark — the Fovea glyph (from assets/app-icon.svg), a luminous core
 * with focus rings converging on it. Always paired with the wordmark in the
 * top bar.
 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
      focusable="false"
      className="fovea-brand-mark"
    >
      <defs>
        <linearGradient id="fovea-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#26313f" />
          <stop offset="1" stopColor="#0f141b" />
        </linearGradient>
        <radialGradient id="fovea-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#5b8def" stopOpacity="0.32" />
          <stop offset="1" stopColor="#5b8def" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="fovea-core" cx="0.38" cy="0.34" r="0.95">
          <stop offset="0" stopColor="#dbe7ff" />
          <stop offset="0.45" stopColor="#8ab1ff" />
          <stop offset="1" stopColor="#4d80f2" />
        </radialGradient>
      </defs>
      <rect width="1024" height="1024" rx="192" fill="url(#fovea-bg)" />
      <circle cx="512" cy="512" r="360" fill="url(#fovea-glow)" />
      <circle
        cx="512"
        cy="512"
        r="448"
        fill="none"
        stroke="#3d5169"
        strokeWidth="30"
        opacity="0.5"
      />
      <path
        d="M 805.1 283 A 372 372 0 1 1 563.8 143.6"
        fill="none"
        stroke="#58728f"
        strokeWidth="56"
        strokeLinecap="round"
      />
      <circle cx="512" cy="512" r="228" fill="none" stroke="#7f98b5" strokeWidth="62" />
      <circle cx="512" cy="512" r="104" fill="url(#fovea-core)" />
    </svg>
  )
}
