import type { Metadata } from 'next';
import { Reveal } from '@/components/Reveal';
import { Cta } from '@/components/Cta';
import { docs, troubleshooting } from '@/lib/docs';
import { systemRequirements } from '@/lib/download';

export const metadata: Metadata = {
  title: 'Documentation',
  description:
    'How to install, activate and use Pixora: importing, enhancement, batch processing, export and troubleshooting — for the app that runs entirely on your machine.',
};

export default function DocsPage() {
  return (
    <>
      <section className="bg-canvas py-14 text-white">
        <div className="container-page">
          <p className="mb-3 text-[0.8rem] font-semibold uppercase tracking-[0.14em] text-steel-light">
            Documentation
          </p>
          <h1 className="font-display text-4xl font-semibold leading-tight sm:text-5xl">
            Use Pixora with confidence.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-steel-light">
            Short, task-focused guides. Everything here describes the app as it actually behaves —
            and none of it needs an internet connection after install.
          </p>
        </div>
      </section>

      <div className="container-page grid gap-12 py-16 lg:grid-cols-[16rem_1fr]">
        {/* Side navigation */}
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <nav aria-label="On this page" className="flex flex-wrap gap-2 lg:flex-col lg:gap-1">
            {docs.map((d) => (
              <a
                key={d.id}
                href={`#${d.id}`}
                className="rounded-md px-3 py-2 text-[0.925rem] font-medium text-ink-2 transition-colors hover:bg-sunken hover:text-ink lg:px-3"
              >
                {d.title}
              </a>
            ))}
            <a
              href="#troubleshooting"
              className="rounded-md px-3 py-2 text-[0.925rem] font-medium text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
            >
              Troubleshooting
            </a>
            <a
              href="#requirements"
              className="rounded-md px-3 py-2 text-[0.925rem] font-medium text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
            >
              System requirements
            </a>
          </nav>
        </aside>

        {/* Articles */}
        <div className="max-w-2xl">
          {docs.map((d) => (
            <Reveal key={d.id}>
              <section id={d.id} className="scroll-mt-24 border-b border-line py-10 first:pt-0">
                <h2 className="font-display text-2xl font-semibold">{d.title}</h2>
                <p className="mt-3 leading-relaxed text-ink-2">{d.intro}</p>
                {d.steps && (
                  <ol className="mt-5 space-y-3">
                    {d.steps.map((s, i) => (
                      <li key={s} className="flex gap-4">
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
                          {i + 1}
                        </span>
                        <span className="pt-0.5 leading-relaxed">{s}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {d.note && (
                  <p className="mt-5 rounded-md border-l-2 border-accent bg-accent-soft/50 px-4 py-3 text-[0.92rem] leading-relaxed text-ink">
                    {d.note}
                  </p>
                )}
              </section>
            </Reveal>
          ))}

          <Reveal>
            <section id="troubleshooting" className="scroll-mt-24 border-b border-line py-10">
              <h2 className="font-display text-2xl font-semibold">Troubleshooting</h2>
              <dl className="mt-5 space-y-5">
                {troubleshooting.map((t) => (
                  <div key={t.q}>
                    <dt className="font-semibold">{t.q}</dt>
                    <dd className="mt-1 leading-relaxed text-ink-2">{t.a}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </Reveal>

          <Reveal>
            <section id="requirements" className="scroll-mt-24 py-10">
              <h2 className="font-display text-2xl font-semibold">System requirements</h2>
              <dl className="mt-5 space-y-3">
                {systemRequirements.map((r) => (
                  <div key={r.k} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3">
                    <dt className="text-sm font-semibold uppercase tracking-wide text-ink-3">
                      {r.k}
                    </dt>
                    <dd className="text-[0.95rem] text-ink">{r.v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </Reveal>

          <div className="mt-10 flex flex-wrap gap-4">
            <Cta href="/download">Download Pixora</Cta>
            <Cta href="/#faq" variant="ghost">
              Read the FAQ
            </Cta>
          </div>
        </div>
      </div>
    </>
  );
}
