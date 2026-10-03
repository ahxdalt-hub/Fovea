/**
 * The Pixora mark — the same geometry as the desktop app icon
 * (assets/app-icon.svg): a dark rounded tile, a steel frame echoing the
 * before/after split, a light image panel with a sun + peaks, and a small
 * enhance sparkle. Inlined so it inherits currentColor and needs no request.
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
        <linearGradient id="pixlogo_bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1d2733" />
          <stop offset="1" stopColor="#0e141c" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="192" fill="url(#pixlogo_bg)" />
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
      <path
        d="M836 188 v96 M788 236 h96"
        stroke="#2f6fed"
        strokeWidth="30"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Wordmark lockup for the nav and footer. */
export function Wordmark({ size = 32 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Logo size={size} />
      <span className="font-display text-[1.35rem] font-semibold tracking-tight">Pixora</span>
    </span>
  );
}
