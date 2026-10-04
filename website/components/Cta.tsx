import type { ReactNode } from 'react';

/**
 * The three call-to-action styles used across the site. `primary` is the
 * accent-filled action, `light` its inverse for dark sections, and `ghost`
 * the quiet ringed alternative. Every Cta takes an explicit href — which
 * destination it points at is the caller's decision, not this component's.
 */
export function Cta({
  href,
  children,
  variant = 'primary',
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'light';
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-pill px-6 py-3 text-[0.95rem] font-semibold transition-[transform,background-color,color,box-shadow] duration-200 ease-out';
  const styles = {
    primary: 'bg-accent text-white shadow-soft hover:bg-accent-strong hover:-translate-y-0.5',
    ghost:
      'border border-line-strong bg-surface text-ink hover:border-ink-3 hover:-translate-y-0.5',
    light: 'bg-white text-canvas hover:-translate-y-0.5',
  }[variant];
  return (
    <a href={href} className={`${base} ${styles}`}>
      {children}
    </a>
  );
}
