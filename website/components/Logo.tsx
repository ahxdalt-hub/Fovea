/**
 * The Fovea mark — the same geometry as the desktop app icon
 * (assets/app-icon.svg): a frame split on the diagonal, out of focus above the
 * seam and lit below it. Inlined so it needs no request and renders at any size.
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
        <linearGradient id="fovea_crisp" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#0f9d8a" />
          <stop offset="0.55" stopColor="#2fd4be" />
          <stop offset="1" stopColor="#b8fff2" />
        </linearGradient>
        <radialGradient id="fovea_core" cx="0.38" cy="0.34" r="0.95">
          <stop offset="0" stopColor="#eafffb" />
          <stop offset="0.45" stopColor="#5fe3d0" />
          <stop offset="1" stopColor="#12a892" />
        </radialGradient>
        <radialGradient id="fovea_glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#2fd4be" stopOpacity="0.26" />
          <stop offset="1" stopColor="#2fd4be" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="fovea_seam" x1="1" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2fd4be" stopOpacity="0" />
          <stop offset="0.4" stopColor="#7ff3e4" stopOpacity="0.85" />
          <stop offset="0.6" stopColor="#2fd4be" stopOpacity="0.85" />
          <stop offset="1" stopColor="#2fd4be" stopOpacity="0" />
        </linearGradient>
        <clipPath id="fovea_tile">
          <rect width="1024" height="1024" rx="192" />
        </clipPath>
        <clipPath id="fovea_soft">
          <path d="M 0 0 H 1024 L 0 1024 Z" />
        </clipPath>
        <clipPath id="fovea_sharp">
          <path d="M 1024 0 V 1024 H 0 Z" />
        </clipPath>
      </defs>
      <rect width="1024" height="1024" rx="192" fill="url(#fovea_bg)" />
      <g clipPath="url(#fovea_tile)">
        <circle cx="660" cy="660" r="400" fill="url(#fovea_glow)" />
        <g clipPath="url(#fovea_soft)">
          <g fill="none" strokeLinecap="round">
            <g stroke="#7e8a99" opacity="0.13">
              <rect x="152" y="152" width="720" height="720" rx="136" strokeWidth="112" />
              <circle cx="512" cy="512" r="244" strokeWidth="96" />
            </g>
            <g stroke="#687484" opacity="0.18" transform="translate(-10 -7)">
              <rect x="176" y="176" width="672" height="672" rx="120" strokeWidth="84" />
              <circle cx="512" cy="512" r="244" strokeWidth="72" />
            </g>
            <g stroke="#8f9aa9" opacity="0.2" transform="translate(9 11)">
              <rect x="176" y="176" width="672" height="672" rx="120" strokeWidth="76" />
              <circle cx="512" cy="512" r="244" strokeWidth="66" />
            </g>
            <g stroke="#aab4c0" opacity="0.34">
              <rect x="176" y="176" width="672" height="672" rx="120" strokeWidth="62" />
              <circle cx="512" cy="512" r="244" strokeWidth="54" />
            </g>
          </g>
          <circle cx="512" cy="512" r="96" fill="#9aa4b2" opacity="0.3" />
          <circle cx="512" cy="512" r="130" fill="#9aa4b2" opacity="0.12" />
        </g>
        <g clipPath="url(#fovea_sharp)">
          <g fill="none" stroke="url(#fovea_crisp)">
            <rect x="176" y="176" width="672" height="672" rx="120" strokeWidth="58" />
            <circle cx="512" cy="512" r="244" strokeWidth="50" />
          </g>
          <circle cx="512" cy="512" r="88" fill="url(#fovea_core)" />
        </g>
        <path d="M 1024 0 L 0 1024" stroke="#0b1017" strokeWidth="16" opacity="0.5" />
        <path d="M 1024 0 L 0 1024" stroke="url(#fovea_seam)" strokeWidth="8" />
      </g>
    </svg>
  );
}

/** Wordmark lockup for the nav and footer. */
export function Wordmark({ size = 32 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Logo size={size} />
      <span className="font-display text-[1.35rem] font-semibold tracking-tight">Fovea</span>
    </span>
  );
}
