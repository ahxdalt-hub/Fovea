import { BeforeAfter } from '@/components/BeforeAfter';
import { Cta } from '@/components/Cta';
import { Reveal } from '@/components/Reveal';
import { Logo } from '@/components/Logo';
import { Check, Eyebrow } from '@/components/SectionBits';
import { faqs, howItWorks, site, tiers } from '@/lib/site';

/** Search-facing structured data: the product, its plans, and the FAQ. */
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'SoftwareApplication',
      name: site.name,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Windows 10, Windows 11 (64-bit)',
      url: site.url,
      description: site.description,
      featureList: [
        'Local AI image enhancement',
        '2× and 4× upscaling',
        'Batch processing up to 500 images',
        'PNG, JPEG and WebP export',
        'DirectML GPU acceleration with CPU fallback',
        'Before/after comparison',
        'Images are never uploaded — the model ships in the app',
      ],
      offers: tiers.map((t) => ({
        '@type': 'Offer',
        name: t.name,
        price: t.price.replace('$', ''),
        priceCurrency: 'USD',
      })),
    },
    {
      '@type': 'FAQPage',
      mainEntity: faqs.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ],
};

export default function Home() {
  return (
    <>
      {/* 1 ─ HERO ────────────────────────────────────────────────────────── */}
      <section id="top" className="relative overflow-hidden bg-canvas text-white">
        <div
          className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-30"
          style={{
            backgroundImage:
              'url(https://images.unsplash.com/photo-1519681393784-d120267933ba?q=80&w=2400&auto=format&fit=crop)',
          }}
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-0 bg-gradient-to-b from-canvas/55 via-transparent to-canvas"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(120% 80% at 80% -10%, #1d2733 0%, rgba(29,39,51,0) 55%), radial-gradient(80% 60% at 0% 0%, rgba(47,212,190,0.16) 0%, rgba(47,212,190,0) 60%)',
          }}
          aria-hidden="true"
        />
        <div className="container-page relative grid items-center gap-14 py-24 lg:grid-cols-[1.05fr_1fr] lg:py-32">
          <div>
            <Eyebrow tone="steel">Local AI image enhancement</Eyebrow>
            <h1 className="font-display text-[2.9rem] font-semibold leading-[1.05] tracking-tight sm:text-6xl">
              Enhance and upscale images on your own computer.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-steel-light">
              Fovea rebuilds detail in your photos with a real AI model that runs entirely on your
              machine. No uploads, no cloud processing, no subscription — just bigger, sharper
              images you can trust.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-4">
              <Cta href="/download?tier=evaluate" variant="light">
                Download Fovea
              </Cta>
              <a
                href="#showcase"
                className="inline-flex items-center gap-2 rounded-pill px-6 py-3 text-[0.95rem] font-semibold text-white/90 ring-1 ring-white/25 transition hover:bg-white/10"
              >
                See real results
              </a>
            </div>
            <p className="mt-6 flex items-center gap-2 text-sm text-steel-light">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
              Free to use · Runs on your machine · Windows 10 &amp; 11
            </p>
          </div>

          {/* Hero uses a genuine before/after pair produced by Fovea. */}
          <Reveal>
            <BeforeAfter
              before="/images/coast-before.jpg"
              after="/images/coast-after.jpg"
              beforeAlt="Original photograph, the small input given to Fovea"
              afterAlt="The same photograph enhanced and upscaled 4× by Fovea"
            />
            <p className="mt-4 text-center text-sm text-steel-light">
              Drag to compare — the “after” side is the real 4× output from Fovea’s model.
            </p>
          </Reveal>
        </div>
      </section>

      {/* 2 ─ PROBLEM ─────────────────────────────────────────────────────── */}
      <section id="problem" className="bg-app py-24">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <Eyebrow>The problem</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Your best photos deserve better than “good enough”.
            </h2>
          </Reveal>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {[
              {
                t: 'Enlarging usually ruins the shot',
                b: 'Stretching a small image just makes it soft and blocky. Print, cropping and high-resolution screens expose every compromise.',
              },
              {
                t: 'Cloud tools put your photos online',
                b: 'Most “AI enhancers” ask you to upload the file to someone else’s server — a non-starter for private, client, or unpublished work.',
              },
              {
                t: 'Subscriptions and accounts everywhere',
                b: 'You pay monthly, create a login, and lose access to your own results the day the service changes its mind.',
              },
            ].map((p, i) => (
              <Reveal key={p.t} delay={i * 90}>
                <div className="border-l-2 border-line-strong pl-5">
                  <h3 className="text-lg font-semibold">{p.t}</h3>
                  <p className="mt-2 leading-relaxed text-ink-2">{p.b}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* 3 ─ SOLUTION ────────────────────────────────────────────────────── */}
      <section className="bg-surface py-24">
        <div className="container-page grid gap-14 lg:grid-cols-2 lg:items-center">
          <Reveal>
            <Eyebrow>The Fovea way</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              A real AI model, doing real reconstruction — locally.
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-ink-2">
              Fovea bundles a proven enhancement model (Real-ESRGAN) inside the app. It doesn’t
              stretch pixels; it rebuilds them, recovering edges, texture and detail that a plain
              resize can only smear. And because the model lives on your computer, that work happens
              without a single byte leaving your machine.
            </p>
            <ul className="mt-8 space-y-3 text-[1.02rem]">
              {[
                'Real 2× and 4× output, generated by the model',
                'Three distinct modes — Standard, Natural, Detail',
                'Runs on your GPU through DirectML, or the CPU',
                'No account, no upload step, no cloud processing',
              ].map((f) => (
                <li key={f} className="flex gap-3">
                  <Check />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </Reveal>
          <Reveal delay={120}>
            <div className="rounded-card border border-line bg-app p-8 shadow-soft">
              <div className="flex items-center gap-3">
                <Logo size={44} />
                <div className="font-display text-2xl font-semibold">Fovea</div>
              </div>
              <div className="mt-6 grid grid-cols-3 gap-3 text-center">
                {[
                  { k: 'Modes', v: '3' },
                  { k: 'Max scale', v: '4×' },
                  { k: 'Uploads', v: '0' },
                ].map((s) => (
                  <div key={s.k} className="rounded-md bg-surface p-4 shadow-soft">
                    <div className="font-display text-3xl font-semibold text-accent">{s.v}</div>
                    <div className="mt-1 text-xs uppercase tracking-wide text-ink-3">{s.k}</div>
                  </div>
                ))}
              </div>
              <p className="mt-6 text-sm leading-relaxed text-ink-2">
                Every number here reflects what the app actually does today — nothing is advertised
                that the desktop build doesn’t deliver.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* 4 ─ SHOWCASE / BEFORE-AFTER ─────────────────────────────────────── */}
      <section id="showcase" className="bg-canvas py-24 text-white">
        <div className="container-page">
          <Reveal className="mx-auto max-w-2xl text-center">
            <Eyebrow tone="steel">Real results</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Judge it with your own eyes.
            </h2>
            <p className="mt-4 text-lg text-steel-light">
              These are genuine Fovea outputs — a small photo on the left, the same image after a
              real 4× enhancement run on the right. Drag each slider.
            </p>
          </Reveal>

          <div className="mt-14 space-y-10">
            <Reveal>
              <BeforeAfter
                before="/images/face-before.jpg"
                after="/images/face-after.jpg"
                beforeAlt="Original portrait, the small input given to Fovea"
                afterAlt="The portrait enhanced and upscaled 4× by Fovea in Natural mode"
                aspect="3 / 2"
              />
            </Reveal>
            <div className="grid gap-10 md:grid-cols-2">
              <Reveal>
                <BeforeAfter
                  before="/images/coast-before.jpg"
                  after="/images/coast-after.jpg"
                  beforeAlt="Original coastal landscape, the small input given to Fovea"
                  afterAlt="The coastal landscape enhanced and upscaled 4× by Fovea in Detail mode"
                  aspect="3 / 2"
                />
              </Reveal>
              <Reveal delay={120}>
                <BeforeAfter
                  before="/images/foliage-before.jpg"
                  after="/images/foliage-after.jpg"
                  beforeAlt="Original foliage, the small input given to Fovea"
                  afterAlt="The foliage enhanced and upscaled 4× by Fovea in Standard mode"
                  aspect="3 / 2"
                />
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* 5 ─ WHY NOT THE ALTERNATIVES ────────────────────────────────────── */}
      <section id="compare" className="bg-surface py-24">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <Eyebrow>Why not just…</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Every other route has a catch.
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-2">
              There are three other ways to upscale a photo. Each one asks you to give something up
              — Fovea was built to give the least.
            </p>
          </Reveal>
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {[
              {
                t: 'Cloud AI enhancers',
                b: 'They all want the same thing first: your file, uploaded to their server, behind an account, paid for in credits or a monthly plan. Fine for casual shots — impossible for client, medical, or unpublished work.',
              },
              {
                t: 'Pro desktop upscalers',
                b: 'Genuinely powerful, and priced for studios. You pay — or live with a watermarked trial — before the tool has earned anything on your own photo. Many assume a specific graphics vendor’s stack.',
              },
              {
                t: 'Free online resizers',
                b: 'They stretch pixels instead of rebuilding them, so you get a bigger file, not more detail. The ones with a real model tend to cap you, watermark you, or both.',
              },
            ].map((c, i) => (
              <Reveal key={c.t} delay={i * 90}>
                <div className="h-full rounded-card border border-line bg-app p-7">
                  <h3 className="font-display text-xl font-semibold">{c.t}</h3>
                  <p className="mt-3 leading-relaxed text-ink-2">{c.b}</p>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={120} className="mt-10">
            <div className="rounded-card bg-canvas p-8 text-white shadow-lift sm:p-10">
              <h3 className="font-display text-2xl font-semibold">What Fovea gives instead</h3>
              <div className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2">
                {[
                  'Your images never leave your machine — there is no upload path to find.',
                  'The free build is the full engine: try everything on your own photos first.',
                  'A one-time license covers rights and machines — never a monthly rent.',
                  'Any DirectX 12 GPU works through DirectML — no CUDA, no account.',
                ].map((f) => (
                  <div key={f} className="flex gap-3">
                    <Check light />
                    <span className="text-[0.98rem] leading-relaxed text-white/90">{f}</span>
                  </div>
                ))}
              </div>
              <div className="mt-8 flex flex-wrap gap-4">
                <Cta href="/download?tier=evaluate" variant="light">
                  Download Fovea
                </Cta>
                <a
                  href="/product"
                  className="inline-flex items-center rounded-pill px-6 py-3 text-[0.95rem] font-semibold text-white/90 ring-1 ring-white/25 transition hover:bg-white/10"
                >
                  See every detail →
                </a>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      {/* 6 ─ HOW IT WORKS ────────────────────────────────────────────────── */}
      <section className="bg-app py-24">
        <div className="container-page">
          <Reveal className="mx-auto max-w-2xl text-center">
            <Eyebrow>How it works</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Five steps, start to finish.
            </h2>
          </Reveal>
          <ol className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
            {howItWorks.map((s, i) => (
              <Reveal key={s.title} delay={i * 80}>
                <li className="h-full rounded-card border border-line bg-surface p-6 shadow-soft">
                  <div className="font-display text-2xl font-semibold text-accent">{i + 1}</div>
                  <h3 className="mt-3 font-semibold">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-2">{s.body}</p>
                </li>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* 7 ─ PRIVACY STRIP ───────────────────────────────────────────────── */}
      <section
        id="privacy"
        className="parallax-band relative bg-canvas py-24 text-white"
        style={{
          backgroundImage:
            'url(https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?q=80&w=2400&auto=format&fit=crop)',
        }}
      >
        <div className="pointer-events-none absolute inset-0 bg-canvas/88" aria-hidden="true" />
        <div className="container-page relative">
          <Reveal className="mx-auto max-w-3xl text-center">
            <Eyebrow tone="steel">Privacy by design</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-5xl">
              Your images never leave your computer.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-steel-light">
              Not a policy promise — a fact of how the software is built. No upload path, no
              analytics beacon, no account. License activation is verified on your machine, and the
              free plan reports nothing but a number — its monthly count, under a hashed install id.
            </p>
            <div className="mx-auto mt-10 inline-flex items-center gap-4 rounded-card border border-white/15 bg-white/5 px-8 py-5">
              <span className="font-display text-5xl font-semibold">0</span>
              <span className="text-left text-sm leading-snug text-steel-light">
                image bytes sent while enhancing
                <br />
                runs on your hardware only
              </span>
            </div>
            <div className="mt-9 flex flex-wrap justify-center gap-4">
              <Cta href="/download?tier=evaluate" variant="light">
                Download Fovea
              </Cta>
              <a
                href="/product#privacy"
                className="inline-flex items-center rounded-pill px-6 py-3 text-[0.95rem] font-semibold text-white/90 ring-1 ring-white/25 transition hover:bg-white/10"
              >
                How it’s built →
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      {/* 8 ─ PRICING ─────────────────────────────────────────────────────── */}
      <section id="pricing" className="bg-surface py-24">
        <div className="container-page">
          <Reveal className="mx-auto max-w-2xl text-center">
            <Eyebrow>Pricing</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              One-time price. Yours to keep.
            </h2>
            <p className="mt-4 text-lg text-ink-2">
              The app is free to run and never metered, so try it on your own photos first. A
              license covers machines and commercial use — it never locks away a feature.
            </p>
          </Reveal>
          <div className="mt-14 grid gap-6 lg:grid-cols-3">
            {tiers.map((tier, i) => (
              <Reveal key={tier.id} delay={i * 90} className="h-full">
                <div
                  className={`flex h-full flex-col rounded-card border p-8 shadow-soft transition-shadow duration-300 hover:shadow-lift ${
                    tier.featured
                      ? 'border-accent bg-canvas text-white ring-1 ring-accent'
                      : 'border-line bg-app'
                  }`}
                >
                  <h3 className="font-display text-xl font-semibold">{tier.name}</h3>
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="font-display text-5xl font-semibold">{tier.price}</span>
                    <span className={tier.featured ? 'text-steel-light' : 'text-ink-3'}>
                      {tier.cadence}
                    </span>
                  </div>
                  <p
                    className={`mt-3 text-[0.95rem] leading-relaxed ${
                      tier.featured ? 'text-steel-light' : 'text-ink-2'
                    }`}
                  >
                    {tier.blurb}
                  </p>
                  <p
                    className={`mt-4 text-sm font-semibold uppercase tracking-wide ${
                      tier.featured ? 'text-white' : 'text-ink'
                    }`}
                  >
                    {tier.seats}
                  </p>
                  <ul className="mt-5 flex-1 space-y-3 text-[0.95rem]">
                    {tier.highlights.map((h) => (
                      <li key={h} className="flex gap-3">
                        <Check light={tier.featured} />
                        <span className={tier.featured ? 'text-white/90' : 'text-ink-2'}>{h}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-8">
                    {tier.id === 'evaluate' ? (
                      <Cta href="/download?tier=evaluate" variant="ghost">
                        Download free
                      </Cta>
                    ) : tier.featured ? (
                      <Cta href={`/api/checkout?tier=${tier.id}`} variant="light">
                        Buy {tier.name}
                      </Cta>
                    ) : (
                      <Cta href={`/api/checkout?tier=${tier.id}`} variant="ghost">
                        Buy {tier.name}
                      </Cta>
                    )}
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
          <p className="mt-8 text-center text-sm text-ink-3">
            Prices shown are introductory and may change. Licensing is offline and verified on your
            machine.{' '}
            <a href="/product#plans" className="font-semibold text-accent hover:underline">
              See the full Free vs Pro vs Studio comparison →
            </a>
          </p>
        </div>
      </section>

      {/* 9 ─ FAQ ─────────────────────────────────────────────────────────── */}
      <section id="faq" className="bg-app py-24">
        <div className="container-page max-w-3xl">
          <Reveal className="text-center">
            <Eyebrow>Questions</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Straight answers.
            </h2>
          </Reveal>
          <div className="mt-12 divide-y divide-line rounded-card border border-line bg-surface shadow-soft">
            {faqs.map((f) => (
              <details key={f.q} className="group px-6 py-1">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 font-semibold marker:hidden">
                  <span>{f.q}</span>
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                    className="shrink-0 text-ink-3 transition-transform duration-200 group-open:rotate-45"
                  >
                    <path
                      d="M12 5v14M5 12h14"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </summary>
                <p className="pb-5 leading-relaxed text-ink-2">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* 10 ─ FINAL CTA ──────────────────────────────────────────────────── */}
      <section
        className="parallax-band relative bg-canvas py-28 text-white"
        style={{
          backgroundImage:
            'url(https://images.unsplash.com/photo-1454496522488-7a8e488e8606?q=80&w=2400&auto=format&fit=crop)',
        }}
      >
        <div className="pointer-events-none absolute inset-0 bg-canvas/85" aria-hidden="true" />
        <div className="container-page relative">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-5xl">
              See what Fovea does to your own photos.
            </h2>
            <p className="mt-5 text-lg text-steel-light">
              Download it, run it on your own machine, and compare the results yourself. The app is
              free to use — add a license when client work or more than one machine needs covering.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-4">
              <Cta href="/download?tier=evaluate" variant="light">
                Download Fovea
              </Cta>
              <a
                href="#pricing"
                className="inline-flex items-center rounded-pill px-6 py-3 text-[0.95rem] font-semibold text-white/90 ring-1 ring-white/25 transition hover:bg-white/10"
              >
                See what a license covers
              </a>
            </div>
          </Reveal>
        </div>
      </section>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
    </>
  );
}
