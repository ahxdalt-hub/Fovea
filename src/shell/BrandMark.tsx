/**
 * BrandMark — the Fovea glyph (from assets/app-icon.svg): a frame split on the
 * diagonal, out of focus above the seam and lit below it. Always paired with
 * the wordmark in the top bar.
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
        <linearGradient id="fovea-crisp" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#0f9d8a" />
          <stop offset="0.55" stopColor="#2fd4be" />
          <stop offset="1" stopColor="#b8fff2" />
        </linearGradient>
        <radialGradient id="fovea-core" cx="0.38" cy="0.34" r="0.95">
          <stop offset="0" stopColor="#eafffb" />
          <stop offset="0.45" stopColor="#5fe3d0" />
          <stop offset="1" stopColor="#12a892" />
        </radialGradient>
        <radialGradient id="fovea-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#2fd4be" stopOpacity="0.26" />
          <stop offset="1" stopColor="#2fd4be" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="fovea-seam" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2fd4be" stopOpacity="0" />
          <stop offset="0.4" stopColor="#7ff3e4" stopOpacity="0.85" />
          <stop offset="0.6" stopColor="#2fd4be" stopOpacity="0.85" />
          <stop offset="1" stopColor="#2fd4be" stopOpacity="0" />
        </linearGradient>
        <clipPath id="fovea-tile">
          <rect width="1024" height="1024" rx="192" />
        </clipPath>
        <clipPath id="fovea-soft">
          <path d="M 0 0 H 1024 L 0 1024 Z" />
        </clipPath>
        <clipPath id="fovea-sharp">
          <path d="M 1024 0 V 1024 H 0 Z" />
        </clipPath>
      </defs>
      <rect width="1024" height="1024" rx="192" fill="url(#fovea-bg)" />
      <g clipPath="url(#fovea-tile)">
        <circle cx="660" cy="660" r="400" fill="url(#fovea-glow)" />
        <g clipPath="url(#fovea-soft)">
          <g fill="none" strokeLinecap="round">
            <g stroke="#7e8a99" opacity="0.13">
              <rect x="152" y="152" width="720" height="720" rx="136" strokeWidth="112" />
              <circle cx="512" cy="512" r="244" strokeWidth="96" />
            </g>
            <g stroke="#687484" opacity="0.18" transform="translate(-10 -7)">
              <rect x="176" y="176" width="672" height="672" rx="120" strokeWidth="84" />
              <circle cx="512" cy="512" r="244" strokeWidth="72" />
            </g>
            <g stroke="#8f9aa9" opacity="0.20" transform="translate(9 11)">
              <rect x="176" y="176" width="672" height="672" rx="120" strokeWidth="76" />
              <circle cx="512" cy="512" r="244" strokeWidth="66" />
            </g>
            <g stroke="#aab4c0" opacity="0.34">
              <rect x="176" y="176" width="672" height="672" rx="120" strokeWidth="62" />
              <circle cx="512" cy="512" r="244" strokeWidth="54" />
            </g>
          </g>
          <circle cx="512" cy="512" r="96" fill="#9aa4b2" opacity="0.30" />
          <circle cx="512" cy="512" r="130" fill="#9aa4b2" opacity="0.12" />
        </g>
        <g clipPath="url(#fovea-sharp)">
          <g fill="none" stroke="url(#fovea-crisp)">
            <rect x="176" y="176" width="672" height="672" rx="120" strokeWidth="58" />
            <circle cx="512" cy="512" r="244" strokeWidth="50" />
          </g>
          <circle cx="512" cy="512" r="88" fill="url(#fovea-core)" />
        </g>
        <path d="M 1024 0 L 0 1024" stroke="#0b1017" strokeWidth="16" opacity="0.5" />
        <path d="M 1024 0 L 0 1024" stroke="url(#fovea-seam)" strokeWidth="8" />
      </g>
    </svg>
  )
}
