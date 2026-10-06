import type { Metadata } from 'next';
import { Cta } from '@/components/Cta';
import { Reveal } from '@/components/Reveal';
import { Check, Eyebrow, PlanCell } from '@/components/SectionBits';
import { benchmarkNote, benchmarks, features, limits, planRows, site } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Product',
  description: `Everything about ${site.name} in depth: full feature list, how the privacy works, the Free vs Pro vs Studio comparison, and measured performance numbers.`,
};

export default function Product() {
  return (
    <>
      {/* 1 ─ HEADER ──────────────────────────────────────────────────────── */}
      <section
        className="parallax-band relative bg-canvas py-20 text-white"
        style={{
          backgroundImage:
            'url(https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?q=80&w=2400&auto=format&fit=crop)',
        }}
      >
        <div className="pointer-events-none absolute inset-0 bg-canvas/88" aria-hidden="true" />
        <div className="container-page relative">
          <Reveal className="max-w-3xl">
            <Eyebrow tone="steel">The in-depth version</Eyebrow>
            <h1 className="font-display text-[2.6rem] font-semibold leading-[1.08] sm:text-5xl">
              Everything about {site.name}, plainly stated.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-steel-light">
              The full feature list, how the offline design actually works, what a license does and
              doesn’t change, and the measured numbers — verified against the shipped desktop build
              today.
            </p>
            <nav className="mt-8 flex flex-wrap gap-3" aria-label="On this page">
              {[
                { href: '#features', label: 'Features' },
                { href: '#privacy', label: 'Privacy' },
                { href: '#plans', label: 'Free vs Pro' },
                { href: '#performance', label: 'Performance' },
                { href: '#audience', label: 'Who it’s for' },
              ].map((c) => (
                <a
                  key={c.href}
                  href={c.href}
                  className="rounded-pill px-5 py-2 text-sm font-semibold text-white/90 ring-1 ring-white/25 transition hover:bg-white/10"
                >
                  {c.label}
                </a>
              ))}
            </nav>
          </Reveal>
        </div>
      </section>

      {/* 2 ─ FEATURES ────────────────────────────────────────────────────── */}
      <section id="features" className="bg-surface py-24">
        <div className="container-page">
          <Reveal className="max-w-2xl">
            <Eyebrow>What you get</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Everything that matters, and nothing that doesn’t.
            </h2>
          </Reveal>
          <div className="mt-14 grid gap-x-10 gap-y-8 md:grid-cols-2">
            {features.map((f, i) => (
              <Reveal key={f.title} delay={(i % 2) * 80}>
                <div className="flex gap-4">
                  <div className="mt-1">
                    <Check />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold">{f.title}</h3>
                    <p className="mt-1.5 leading-relaxed text-ink-2">{f.body}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* 3 ─ PRIVACY / LOCAL ─────────────────────────────────────────────── */}
      <section id="privacy" className="bg-app py-24">
        <div className="container-page grid gap-14 lg:grid-cols-[1.1fr_1fr] lg:items-center">
          <Reveal>
            <Eyebrow>Privacy by design</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Your images never leave your computer.
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-ink-2">
              This isn’t a policy promise — it’s how the software is built. There is no upload path,
              no analytics beacon, and no account. License activation is verified on your machine,
              and the only thing the app ever reports to us is a number: the free plan’s monthly
              count, under a hashed install id.
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              {[
                { t: 'No upload', b: 'Nothing sends your file anywhere.' },
                { t: 'No account', b: 'Open it and work. No login.' },
                { t: 'No cloud processing', b: 'The model ships in the app.' },
              ].map((c) => (
                <div key={c.t} className="rounded-card border border-line bg-surface p-5">
                  <div className="font-semibold">{c.t}</div>
                  <p className="mt-1 text-sm text-ink-2">{c.b}</p>
                </div>
              ))}
            </div>
          </Reveal>
          <Reveal delay={120}>
            <div className="relative rounded-card bg-canvas p-8 text-white shadow-lift">
              <div className="flex items-center gap-2 text-sm text-steel-light">
                <span className="inline-block h-2 w-2 rounded-full bg-accent" />
                Image bytes sent while enhancing
              </div>
              <div className="mt-8 text-center">
                <div className="font-display text-6xl font-semibold">0</div>
                <p className="mt-2 text-steel-light">not one · runs on your hardware only</p>
              </div>
              <p className="mt-8 text-sm leading-relaxed text-white/70">
                The model is inside the app. A paid plan makes no network call at all; the free
                plan’s only traffic is its monthly count — a hashed install id and a number, never a
                file — and the app caches the balance, so enhancement, batch runs, export and even
                activation all complete without a connection.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* 4 ─ FREE vs PRO vs STUDIO ───────────────────────────────────────── */}
      <section id="plans" className="bg-surface py-24">
        <div className="container-page">
          <Reveal className="mx-auto max-w-3xl text-center">
            <Eyebrow>Free, Pro and Studio</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              One engine, three ceilings. Here is the honest difference.
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-2">
              The free plan is capped in four named ways: 2× rather than 4×, Standard mode rather
              than all three, no Portrait look, and ten enhancements a calendar month. A key lifts
              exactly those four, and covers commercial use on more machines. Everything else —
              batch, history, every export format, GPU acceleration, no watermark — runs with
              nothing entered. Each row below is enforced by the app, not just claimed here.
            </p>
          </Reveal>

          <Reveal className="mt-12 overflow-x-auto rounded-card border border-line bg-app shadow-soft">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <caption className="sr-only">
                What Fovea Free, Fovea Pro and Fovea Studio each include
              </caption>
              <thead>
                <tr className="border-b border-line">
                  <th
                    scope="col"
                    className="px-6 py-5 text-sm font-semibold uppercase tracking-wide text-ink-3"
                  >
                    Capability
                  </th>
                  {(['free', 'pro', 'studio'] as const).map((col) => (
                    <th
                      key={col}
                      scope="col"
                      className="px-6 py-5 text-center font-display text-lg font-semibold"
                    >
                      {col === 'free' ? 'Free' : col === 'pro' ? 'Pro' : 'Studio'}
                      <span className="mt-1 block text-xs font-normal normal-case tracking-normal text-ink-3">
                        {col === 'free' ? '$0' : col === 'pro' ? '$49 one-time' : '$129 one-time'}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {planRows.map((row) => (
                  <tr key={row.label} className="border-b border-line last:border-0">
                    <th scope="row" className="px-6 py-4 text-left align-top font-normal">
                      <span className="block font-semibold text-ink">{row.label}</span>
                      <span className="mt-1 block text-sm leading-relaxed text-ink-3">
                        {row.note}
                      </span>
                    </th>
                    {(['free', 'pro', 'studio'] as const).map((col) => (
                      <td key={col} className="px-6 py-4 text-center align-middle">
                        <PlanCell value={row[col]} label={row.label} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Reveal>

          <p className="mx-auto mt-8 max-w-3xl text-center text-[0.95rem] leading-relaxed text-ink-2">
            If you only ever need 2× in Standard mode, ten images a month is a real working tool and
            we would rather you knew where its ceiling sits before paying. Buy a license when you
            want the top end of the engine, unlimited processing, client work, or more than one
            machine covered.{' '}
            <a href="/#pricing" className="font-semibold text-accent hover:underline">
              Go to pricing →
            </a>
          </p>
        </div>
      </section>

      {/* 5 ─ PERFORMANCE / HARDWARE ──────────────────────────────────────── */}
      <section id="performance" className="bg-app py-24">
        <div className="container-page grid gap-14 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <Eyebrow>Performance</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Uses the hardware you already have.
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-ink-2">
              Fovea accelerates enhancement with any DirectX 12 graphics card through DirectML —
              that covers AMD, Intel and NVIDIA on Windows, with no CUDA required. No dedicated GPU?
              It falls back to your processor automatically and still delivers the same quality,
              just more patiently.
            </p>
            <p className="mt-4 leading-relaxed text-ink-2">
              Tile size is planned from the memory actually free when a job starts, so an image
              bigger than your graphics memory costs you time rather than crashing the app.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <dl className="rounded-card border border-line bg-surface p-8 shadow-soft">
              {[
                { k: 'GPU path', v: 'DirectML — AMD, Intel, NVIDIA (DirectX 12)' },
                { k: 'No CUDA needed', v: 'Runs without NVIDIA-specific tooling' },
                { k: 'CPU fallback', v: 'Automatic — a missing GPU never breaks a run' },
                { k: 'Tiling', v: 'Adaptive, planned from your free RAM and VRAM' },
                { k: 'Network', v: 'None at run time' },
              ].map((row, i) => (
                <div
                  key={row.k}
                  className={`grid grid-cols-[1fr_1.4fr] gap-4 py-3 ${
                    i ? 'border-t border-line' : ''
                  }`}
                >
                  <dt className="text-sm font-semibold uppercase tracking-wide text-ink-3">
                    {row.k}
                  </dt>
                  <dd className="text-[0.95rem] text-ink">{row.v}</dd>
                </div>
              ))}
            </dl>
          </Reveal>
        </div>

        <div className="container-page mt-20">
          <Reveal className="max-w-3xl">
            <Eyebrow tone="steel">The limits, up front</Eyebrow>
            <h3 className="font-display text-2xl font-semibold leading-tight sm:text-3xl">
              Nothing hidden until you hit it.
            </h3>
          </Reveal>
          <dl className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {limits.map((l, i) => (
              <Reveal key={l.k} delay={(i % 4) * 70}>
                <div className="border-t border-line pt-5">
                  <dt className="text-sm font-semibold uppercase tracking-wide text-ink-3">
                    {l.k}
                  </dt>
                  <dd className="mt-1 font-display text-lg font-semibold text-ink">{l.v}</dd>
                  <p className="mt-2 text-[0.9rem] leading-relaxed text-ink-2">{l.d}</p>
                </div>
              </Reveal>
            ))}
          </dl>
        </div>
      </section>

      {/* 6 ─ BENCHMARKS ──────────────────────────────────────────────────── */}
      <section className="bg-surface py-20">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <Eyebrow>Measured, not estimated</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Real end-to-end times on one test laptop.
            </h2>
            <p className="mt-4 leading-relaxed text-ink-2">
              Each row is a complete run — decode, model inference, encode, write — at 4×, measured
              on an RTX 3050 Laptop (6 GB) with a Ryzen 5 5600. Your results will differ with your
              hardware.
            </p>
          </Reveal>
          <Reveal className="mt-8 overflow-x-auto rounded-card border border-line bg-app shadow-soft">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <caption className="sr-only">
                Measured Fovea enhancement times, throughput and peak memory by source size
              </caption>
              <thead>
                <tr className="border-b border-line">
                  {['Source size', 'Engine', 'Tile', 'Time', 'Throughput', 'Peak memory'].map(
                    (h) => (
                      <th
                        key={h}
                        scope="col"
                        className="px-5 py-4 text-sm font-semibold uppercase tracking-wide text-ink-3"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {benchmarks.map((b) => (
                  <tr key={`${b.size}-${b.engine}`} className="border-b border-line last:border-0">
                    <th scope="row" className="px-5 py-3 text-left font-semibold text-ink">
                      {b.size}
                    </th>
                    <td className="px-5 py-3 text-[0.92rem] text-ink-2">{b.engine}</td>
                    <td className="px-5 py-3 font-display tabular-nums">{b.tile}</td>
                    <td className="px-5 py-3 font-display tabular-nums">{b.time}</td>
                    <td className="px-5 py-3 font-display tabular-nums">{b.rate}</td>
                    <td className="px-5 py-3 font-display tabular-nums">{b.peak}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Reveal>
          <p className="mt-5 max-w-3xl text-[0.92rem] leading-relaxed text-ink-3">
            {benchmarkNote}
          </p>
        </div>
      </section>

      {/* 7 ─ WHO IT'S FOR ────────────────────────────────────────────────── */}
      <section
        id="audience"
        className="parallax-band relative bg-canvas py-24 text-white"
        style={{
          backgroundImage:
            'url(https://images.unsplash.com/photo-1447752875215-b2761acb3c5d?q=80&w=2400&auto=format&fit=crop)',
        }}
      >
        <div className="pointer-events-none absolute inset-0 bg-canvas/85" aria-hidden="true" />
        <div className="container-page relative">
          <Reveal className="mx-auto max-w-2xl text-center">
            <Eyebrow tone="steel">Who it’s for</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Built for people who care where their files go.
            </h2>
          </Reveal>
          <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {[
              {
                t: 'Photographers',
                b: 'Rescue older, smaller shots and prepare large, print-ready files — privately.',
              },
              {
                t: 'Designers & illustrators',
                b: 'Turn low-res drafts into sharp, usable assets without a cloud round-trip.',
              },
              {
                t: 'Archivists & families',
                b: 'Restore scans and old photos on your own machine, with no service to outlive them.',
              },
              {
                t: 'Anyone with private work',
                b: 'Client, medical, legal or personal images that should never touch a server.',
              },
            ].map((a, i) => (
              <Reveal key={a.t} delay={i * 80}>
                <div className="h-full rounded-card border border-white/10 bg-canvas-2/60 p-6">
                  <h3 className="font-display text-xl font-semibold">{a.t}</h3>
                  <p className="mt-3 leading-relaxed text-steel-light">{a.b}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* 8 ─ CTA ─────────────────────────────────────────────────────────── */}
      <section className="bg-app py-20">
        <div className="container-page">
          <Reveal className="mx-auto flex max-w-2xl flex-col items-center text-center">
            <h2 className="font-display text-2xl font-semibold leading-tight sm:text-3xl">
              Enough reading — run it on your own photo.
            </h2>
            <p className="mt-3 text-ink-2">
              Standard mode at 2×, ten images a month. No account, no watermark, no time limit.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-4">
              <Cta href="/download?tier=evaluate">Download Fovea</Cta>
              <a
                href="/#compare"
                className="inline-flex items-center rounded-pill px-6 py-3 text-[0.95rem] font-semibold text-ink-2 ring-1 ring-line-strong transition hover:border-ink-3 hover:text-ink"
              >
                Back to why Fovea
              </a>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
