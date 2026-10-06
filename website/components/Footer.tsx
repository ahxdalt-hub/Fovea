import { Wordmark } from '@/components/Logo';
import { navLinks, site } from '@/lib/site';

export function Footer() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="container-page flex flex-col gap-8 py-12 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <a href="/" className="inline-flex text-ink" aria-label="Fovea home">
            <Wordmark />
          </a>
          <p className="mt-3 text-[0.95rem] leading-relaxed text-ink-2">{site.tagline}</p>
        </div>

        <nav className="flex flex-wrap gap-x-10 gap-y-3" aria-label="Footer">
          {navLinks.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-[0.9rem] font-medium text-ink-2 transition-colors hover:text-ink"
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>

      <div className="border-t border-line">
        <div className="container-page flex flex-col gap-2 py-5 text-[0.82rem] text-ink-3 sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {site.name}. All rights reserved.
          </p>
          <p>Your images never leave your machine — and a paid plan needs no connection at all.</p>
        </div>
      </div>
    </footer>
  );
}
