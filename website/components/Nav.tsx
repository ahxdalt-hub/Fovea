'use client';

import { useEffect, useState } from 'react';
import { Wordmark } from '@/components/Logo';
import { Cta } from '@/components/Cta';
import { navLinks } from '@/lib/site';

export function Nav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        scrolled ? 'border-b border-line bg-app/90 backdrop-blur-md' : 'border-b border-transparent'
      }`}
    >
      <nav className="container-page flex h-16 items-center justify-between" aria-label="Primary">
        <a href="#top" className="text-ink" aria-label="Pixora home">
          <Wordmark />
        </a>

        <div className="hidden items-center gap-8 md:flex">
          {navLinks.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-[0.925rem] font-medium text-ink-2 transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </div>

        <div className="hidden md:block">
          <Cta href="#pricing">Download</Cta>
        </div>

        <button
          type="button"
          className="grid h-10 w-10 place-items-center rounded-md text-ink md:hidden"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label="Toggle menu"
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {open ? (
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </nav>

      {open && (
        <div id="mobile-menu" className="border-t border-line bg-app md:hidden">
          <div className="container-page flex flex-col gap-1 py-4">
            {navLinks.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="rounded-md px-3 py-2.5 text-[0.95rem] font-medium text-ink-2 hover:bg-sunken hover:text-ink"
              >
                {l.label}
              </a>
            ))}
            <div className="px-3 pt-3">
              <Cta href="#pricing">Download</Cta>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
