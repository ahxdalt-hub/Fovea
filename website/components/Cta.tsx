import type { ReactNode } from 'react';

/**
 * The two call-to-action styles used across the page. "Buy / download live"
 * means the primary action leads to the pricing section (where a purchase or
 * download would happen); the secondary is a quieter in-page jump.
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
    primary:
      'bg-accent text-white shadow-soft hover:bg-accent-strong hover:-translate-y-0.5',
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
