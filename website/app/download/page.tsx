import type { Metadata } from 'next';
import { Cta } from '@/components/Cta';
import { Reveal } from '@/components/Reveal';
import { site, tiers, type Tier } from '@/lib/site';
import { downloadInfo, systemRequirements } from '@/lib/download';
import { supabaseConfigured, getOrderByExternalId, type OrderRow } from '@/lib/supabase';
import type { TierId } from '@/lib/commerce';

export const metadata: Metadata = {
  title: 'Download & activate',
  description:
    'Install Fovea, enter your license key, and start enhancing on your own machine. System requirements, activation steps and troubleshooting in one place.',
};

const ACTIVATION_STEPS = [
  'Run the installer and open Fovea.',
  'Open Settings (the gear icon, or press Ctrl + ,).',
  'Choose the License section.',
  'Paste your license key (it starts with FOVEA1.) into the box.',
  'Press Activate. Verification happens on your machine — no internet needed.',
];

function findTier(id: string | undefined): Tier | undefined {
  return tiers.find((t) => t.id === id);
}

function heading(tier: Tier | undefined) {
  if (!tier || tier.id === 'evaluate') {
    return {
      eyebrow: 'Get started',
      title: 'Download Fovea',
      note: 'Fovea is free to download and run. Enhancement works with or without a license, so you can try it on your own photos before you decide.',
    };
  }
  return {
    eyebrow: 'Almost there',
    title: `Thanks — here’s how to get ${tier.name}`,
    note: 'Keep your order confirmation. Your license key is delivered with your purchase; the steps below install the app and activate it on this machine.',
  };
}

export default async function DownloadPage(props: {
  searchParams: Promise<{ tier?: string; source?: string; session_id?: string }>;
}) {
  const { tier: tierParam, session_id: sessionId } = await props.searchParams;
  const tier = findTier(tierParam);
  const h = heading(tier);
  const dl = downloadInfo();

  // Stripe returns the buyer with the Checkout Session id. That id is a long
  // random string only the buyer (and Stripe) know, so it doubles as the
  // lookup token for the license the webhook claimed on payment.
  const order: OrderRow | null =
    sessionId && supabaseConfigured()
      ? await getOrderByExternalId(sessionId).catch(() => null)
      : null;

  return (
    <>
      <section className="bg-canvas py-16 text-white">
        <div className="container-page">
          <Reveal className="max-w-3xl">
            <p className="mb-3 text-[0.8rem] font-semibold uppercase tracking-[0.14em] text-steel-light">
              {h.eyebrow}
            </p>
            <h1 className="font-display text-4xl font-semibold leading-tight sm:text-5xl">
              {h.title}
            </h1>
            <p className="mt-4 text-lg text-steel-light">{h.note}</p>
          </Reveal>

          <Reveal className="mt-8" delay={80}>
            {dl.published ? (
              <div className="flex flex-wrap items-center gap-4">
                <a
                  href={dl.url ?? '#'}
                  className="inline-flex items-center gap-2 rounded-pill bg-white px-7 py-3.5 text-[1rem] font-semibold text-canvas shadow-soft transition hover:-translate-y-0.5"
                >
                  Download for Windows
                  {dl.size ? <span className="text-canvas/60">· {dl.size}</span> : null}
                </a>
                <div className="text-sm text-steel-light">
                  {dl.version ? `Version ${dl.version} · ` : ''}Windows 10 &amp; 11, 64-bit
                </div>
              </div>
            ) : (
              <div className="rounded-card border border-white/15 bg-canvas-2/60 p-6">
                <p className="font-semibold text-white">The installer isn’t published yet.</p>
                <p className="mt-2 text-[0.95rem] leading-relaxed text-steel-light">
                  This is a pre-launch note, not a broken link. When a build is uploaded, the
                  download button and its direct link appear here automatically. What you bought and
                  the activation steps below are already accurate.
                </p>
              </div>
            )}
          </Reveal>
        </div>
      </section>

      {/* What they purchased */}
      {tier && tier.id !== 'evaluate' && (
        <section className="bg-surface py-16">
          <div className="container-page">
            <h2 className="font-display text-2xl font-semibold">What you purchased</h2>
            <div className="mt-6 grid gap-6 sm:grid-cols-2">
              <div className="rounded-card border border-line bg-app p-6 shadow-soft">
                <div className="text-sm uppercase tracking-wide text-ink-3">Edition</div>
                <div className="mt-1 font-display text-xl font-semibold">{tier.name}</div>
                <div className="mt-1 text-ink-2">
                  {tier.price} {tier.cadence} · {tier.seats}
                </div>
              </div>
              <div className="rounded-card border border-line bg-app p-6 shadow-soft">
                <div className="text-sm uppercase tracking-wide text-ink-3">License key</div>
                {order?.license_key ? (
                  <>
                    <div className="mt-2 rounded-lg bg-sunken p-3">
                      <code className="block break-all text-[0.85rem] leading-relaxed text-ink">
                        {order.license_key}
                      </code>
                    </div>
                    <p className="mt-2 text-[0.95rem] leading-relaxed text-ink-2">
                      Copy this key now and activate below — then keep your order confirmation as a
                      backup. It works on this machine immediately; verification is offline.
                    </p>
                  </>
                ) : order ? (
                  <p className="mt-1 text-[0.95rem] leading-relaxed text-ink-2">
                    Your payment is confirmed and your key is being finalized. Refresh this page in
                    a moment; if it doesn’t appear, reply to your purchase confirmation and we’ll
                    deliver it by hand.
                  </p>
                ) : (
                  <p className="mt-1 text-[0.95rem] leading-relaxed text-ink-2">
                    A key beginning <code className="rounded bg-sunken px-1">FOVEA1.</code> is issued
                    with your order and delivered by your purchase channel. Keep the confirmation email
                    — the key is how you activate below.
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Activation */}
      <section className="bg-app py-16">
        <div className="container-page grid gap-12 lg:grid-cols-[1.1fr_1fr]">
          <Reveal>
            <h2 className="font-display text-2xl font-semibold sm:text-3xl">Activate in a minute</h2>
            <ol className="mt-6 space-y-4">
              {ACTIVATION_STEPS.map((s, i) => (
                <li key={s} className="flex gap-4">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
                    {i + 1}
                  </span>
                  <span className="pt-0.5 text-[1.02rem] leading-relaxed">{s}</span>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-[0.95rem] leading-relaxed text-ink-2">
              Activation changes the commercial record of your copy, never what the app can do:
              import, enhance, batch and export all run on this machine whether or not a key is
              present.
            </p>
          </Reveal>

          <Reveal delay={100}>
            <div className="rounded-card border border-line bg-surface p-6 shadow-soft">
              <h3 className="font-semibold">System requirements</h3>
              <dl className="mt-4 space-y-3">
                {systemRequirements.map((r) => (
                  <div key={r.k} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3">
                    <dt className="text-sm font-semibold uppercase tracking-wide text-ink-3">
                      {r.k}
                    </dt>
                    <dd className="text-[0.95rem] text-ink">{r.v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Help */}
      <section className="bg-surface py-16">
        <div className="container-page">
          <h2 className="font-display text-2xl font-semibold">Where to get help</h2>
          <p className="mt-4 max-w-2xl text-ink-2">
            Installation, activation and everyday use are covered in the{' '}
            <a href="/docs" className="font-semibold text-accent hover:underline">
              product documentation
            </a>
            . If something about your order or key needs a human, reply to your purchase
            confirmation with your license id (the value shown under “License id” in Settings →
            License) so we can find it.
          </p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Cta href="/docs">Read the docs</Cta>
            <Cta href="/#pricing" variant="ghost">
              Back to pricing
            </Cta>
          </div>
          <p className="mt-8 text-sm text-ink-3">
            {site.name} · {site.tagline}
          </p>
        </div>
      </section>
    </>
  );
}
