import { BeforeAfter } from '@/components/BeforeAfter'
import { Cta } from '@/components/Cta'
import { Reveal } from '@/components/Reveal'
import { Logo } from '@/components/Logo'
import {
  benchmarkNote,
  benchmarks,
  faqs,
  features,
  howItWorks,
  limits,
  planRows,
  site,
  tiers,
  trustDetails,
  type PlanValue,
} from '@/lib/site'

/** Small centered eyebrow label above a heading. */
function Eyebrow({ children, tone = 'accent' }: { children: string; tone?: 'accent' | 'steel' }) {
  return (
    <p
      className={`mb-4 text-[0.8rem] font-semibold uppercase tracking-[0.14em] ${
        tone === 'steel' ? 'text-steel-light' : 'text-accent'
      }`}
    >
      {children}
    </p>
  )
}

function Check({ light = false }: { light?: boolean }) {
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
  )
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
  )
}

/** A plan-matrix cell: yes, no, or the honest words that replace either. */
function PlanCell({ value, label }: { value: PlanValue; label: string }) {
  if (value === true)
    return (
      <span
        className="inline-flex items-center gap-1 text-accent"
        aria-label={`${label}: included`}
      >
        <Check />
        <span className="sr-only">Included</span>
      </span>
    )
  if (value === false)
    return (
      <span className="inline-flex items-center gap-1" aria-label={`${label}: not included`}>
        <Cross />
        <span className="sr-only">Not included</span>
      </span>
    )
  return <span className="text-[0.9rem] text-ink-2">{value}</span>
}

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
        'Fully offline — images are never uploaded',
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
}

export default function Home() {
  return (
    <>
      {' '}
      {/* 1 ─ HERO ───────────────────────────────────────────────────────── */}
      <section id="top" className="relative overflow-hidden bg-canvas text-white">
        <div
          className="pointer-events-none absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(120% 80% at 80% -10%, #1d2733 0%, rgba(29,39,51,0) 55%), radial-gradient(80% 60% at 0% 0%, rgba(47,111,237,0.16) 0%, rgba(47,111,237,0) 60%)',
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
              machine. No uploads, no cloud, no subscription server — just bigger, sharper images
              you can trust.
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
              Works fully offline · Windows 10 &amp; 11
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
      {/* 2 ─ PROBLEM ────────────────────────────────────────────────────── */}
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
      {/* 3 ─ SOLUTION ───────────────────────────────────────────────────── */}
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
                'No account, no server, no upload step',
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
      {/* 4 ─ SHOWCASE / BEFORE-AFTER ────────────────────────────────────── */}
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
      {/* 5 ─ PRIVACY / LOCAL ────────────────────────────────────────────── */}
      <section id="privacy" className="bg-surface py-24">
        <div className="container-page grid gap-14 lg:grid-cols-[1.1fr_1fr] lg:items-center">
          <Reveal>
            <Eyebrow>Privacy by design</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Your images never leave your computer.
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-ink-2">
              This isn’t a policy promise — it’s how the software is built. There is no upload path,
              no analytics beacon, and no account. Once Fovea is installed it works entirely
              offline; even license activation is verified on your machine.
            </p>
            <div className="mt-8 grid gap-4 sm:grid-cols-3">
              {[
                { t: 'No upload', b: 'Nothing sends your file anywhere.' },
                { t: 'No account', b: 'Open it and work. No login.' },
                { t: 'No server', b: 'The model ships in the app.' },
              ].map((c) => (
                <div key={c.t} className="rounded-card border border-line bg-app p-5">
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
                Network activity while enhancing
              </div>
              <div className="mt-8 text-center">
                <div className="font-display text-6xl font-semibold">0</div>
                <p className="mt-2 text-steel-light">bytes sent · runs on your hardware only</p>
              </div>
              <p className="mt-8 text-sm leading-relaxed text-white/70">
                After the one-time download and install, enhancement, batch runs, export and even
                activation all complete without a connection.
              </p>
            </div>
          </Reveal>
        </div>
      </section>
      {/* 6 ─ HOW IT WORKS ───────────────────────────────────────────────── */}
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
      {/* 7 ─ FEATURES ───────────────────────────────────────────────────── */}
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
      {/* 8 ─ FREE vs PRO vs STUDIO ──────────────────────────────────────── */}
      <section id="plans" className="bg-app py-24">
        <div className="container-page">
          <Reveal className="mx-auto max-w-3xl text-center">
            <Eyebrow>Free, Pro and Studio</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              Same engine in every column. Here is the honest difference.
            </h2>
            <p className="mt-4 text-lg leading-relaxed text-ink-2">
              Fovea does not meter you and does not lock a mode behind a key. A license covers
              commercial use and more machines — it is a signed record of your right to use the app,
              not a switch inside the image pipeline.
            </p>
          </Reveal>

          <Reveal className="mt-12 overflow-x-auto rounded-card border border-line bg-surface shadow-soft">
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
            If you only enhance your own photos, the free build is the complete product and we would
            rather you knew that before paying. Buy a license when client work, a business, or more
            than one machine needs to be covered.
          </p>
        </div>
      </section>
      {/* 9 ─ WHO IT'S FOR ───────────────────────────────────────────────── */}
      <section className="bg-canvas py-24 text-white">
        <div className="container-page">
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
      {/* 10 ─ PERFORMANCE / HARDWARE ────────────────────────────────────── */}
      <section id="hardware" className="bg-app py-24">
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
            <Eyebrow>Measured, not estimated</Eyebrow>
            <h3 className="font-display text-2xl font-semibold leading-tight sm:text-3xl">
              Real end-to-end times on one test laptop.
            </h3>
            <p className="mt-4 leading-relaxed text-ink-2">
              Each row is a complete run — decode, model inference, encode, write — at 4×, measured
              on an RTX 3050 Laptop (6 GB) with a Ryzen 5 5600. Your results will differ with your
              hardware.
            </p>
          </Reveal>
          <Reveal className="mt-8 overflow-x-auto rounded-card border border-line bg-surface shadow-soft">
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
      {/* 11 ─ TRUST DETAILS ────────────────────────────────────────────── */}
      <section className="bg-surface py-20">
        <div className="container-page">
          <Reveal className="max-w-2xl">
            <Eyebrow>Plain facts</Eyebrow>
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-4xl">
              The details you check before you buy.
            </h2>
          </Reveal>
          <dl className="mt-12 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
            {trustDetails.map((t, i) => (
              <Reveal key={t.label} delay={(i % 3) * 80}>
                <div className="border-t border-line pt-5">
                  <dt className="text-sm font-semibold uppercase tracking-wide text-ink-3">
                    {t.label}
                  </dt>
                  <dd className="mt-1 font-display text-xl font-semibold text-ink">{t.value}</dd>
                  <p className="mt-2 text-[0.92rem] leading-relaxed text-ink-2">{t.detail}</p>
                </div>
              </Reveal>
            ))}
          </dl>
        </div>
      </section>
      {/* 12 ─ PRICING ──────────────────────────────────────────────────── */}
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
                  className={`flex h-full flex-col rounded-card border p-8 shadow-soft ${
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
            machine; see the FAQ for how activation and machine coverage work.
          </p>
        </div>
      </section>
      {/* 13 ─ FAQ ───────────────────────────────────────────────────────── */}
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
      {/* 14 ─ FINAL CTA ─────────────────────────────────────────────────── */}
      <section className="bg-canvas py-24 text-white">
        <div className="container-page">
          <Reveal className="mx-auto max-w-2xl text-center">
            <h2 className="font-display text-3xl font-semibold leading-tight sm:text-5xl">
              See what Fovea does to your own photos.
            </h2>
            <p className="mt-5 text-lg text-steel-light">
              Download it, run it offline, and compare the results yourself. The app is free to use
              — add a license when client work or more than one machine needs covering.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-4">
              <Cta href="/download?tier=evaluate" variant="light">
                Download Fovea
              </Cta>
              <a
                href="#plans"
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
  )
}
