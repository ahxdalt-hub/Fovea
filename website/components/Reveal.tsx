'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A quiet entrance for content as it scrolls into view. Purely
 * presentational: it renders a plain div and flips `data-shown` once (the
 * CSS handles the actual transition, and it degrades to "always visible"
 * when JS is off or motion is reduced).
 */
export function Reveal({
  children,
  className = '',
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      el.setAttribute('data-shown', 'true');
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute('data-shown', 'true');
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`reveal ${className}`.trim()}
      style={{ ['--reveal-delay' as string]: `${delay}ms` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}
