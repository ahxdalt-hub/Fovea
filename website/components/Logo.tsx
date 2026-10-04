/**
 * The Fovea mark — the same geometry as the desktop app icon
 * (assets/app-icon.svg): a dark rounded tile with a luminous core and
 * focus rings converging on it, the point of sharpest vision. Inlined so
 * it needs no request and renders at any size.
 */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
      role="img"
      style={{ display: 'block' }}
    >
      <defs>
        <linearGradient id="fovea_bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#26313f" />
          <stop offset="1" stopColor="#0f141b" />
        </linearGradient>
        <radialGradient id="fovea_glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#5b8def" stopOpacity="0.32" />
          <stop offset="1" stopColor="#5b8def" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="fovea_core" cx="0.38" cy="0.34" r="0.95">
          <stop offset="0" stopColor="#dbe7ff" />
          <stop offset="0.45" stopColor="#8ab1ff" />
          <stop offset="1" stopColor="#4d80f2" />
        </radialGradient>
      </defs>
      <rect width="1024" height="1024" rx="192" fill="url(#fovea_bg)" />
      <circle cx="512" cy="512" r="360" fill="url(#fovea_glow)" />
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
      <circle cx="512" cy="512" r="104" fill="url(#fovea_core)" />
    </svg>
  )
}

/** Wordmark lockup for the nav and footer. */
export function Wordmark({ size = 32 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Logo size={size} />
      <span className="font-display text-[1.35rem] font-semibold tracking-tight">Fovea</span>
    </span>
  )
}
