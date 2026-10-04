import type { PlanValue } from '@/lib/site';

/** Small centered eyebrow label above a heading. */
export function Eyebrow({
  children,
  tone = 'accent',
}: {
  children: string;
  tone?: 'accent' | 'steel';
}) {
  return (
    <p
      className={`mb-4 text-[0.8rem] font-semibold uppercase tracking-[0.14em] ${
        tone === 'steel' ? 'text-steel-light' : 'text-accent'
      }`}
    >
      {children}
    </p>
  );
}

export function Check({ light = false }: { light?: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={`mt-0.5 shrink-0 ${light ? 'text-steel-light' : 'text-accent'}`}
    >
      <path
        d="M20 6 9 17l-5-5"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Cross() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-ink-3"
    >
      <path
        d="M6 6l12 12M18 6 6 18"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** A plan-matrix cell: yes, no, or the honest words that replace either. */
export function PlanCell({ value, label }: { value: PlanValue; label: string }) {
  if (value === true)
    return (
      <span
        className="inline-flex items-center gap-1 text-accent"
        aria-label={`${label}: included`}
      >
        <Check />
        <span className="sr-only">Included</span>
      </span>
    );
  if (value === false)
    return (
      <span className="inline-flex items-center gap-1" aria-label={`${label}: not included`}>
        <Cross />
        <span className="sr-only">Not included</span>
      </span>
    );
  return <span className="text-[0.9rem] text-ink-2">{value}</span>;
}
