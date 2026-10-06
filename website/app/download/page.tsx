import type { Metadata } from 'next';
import { Cta } from '@/components/Cta';
import { Reveal } from '@/components/Reveal';
import { planFacts, site, tiers, type Tier } from '@/lib/site';
import { downloadInfo, systemRequirements, type PlanId } from '@/lib/download';
import { supabaseConfigured, getOrderByExternalId, type OrderRow } from '@/lib/supabase';

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

/** Which ceiling table this visit is about. A buyer arriving from checkout
 * sees the plan they paid for; anyone else sees the free plan they are
 * about to run — which is also the honest first screen of a paid install,
 * because a key is only a paste away. */
function planKey(tier: Tier | undefined): 'evaluate' | 'pro' | 'studio' {
  if (tier?.id === 'pro') return 'pro';
  if (tier?.id === 'studio') return 'studio';
  return 'evaluate';
}

function heading(tier: Tier | undefined) {
  if (!tier || tier.id === 'evaluate') {
    return {
      eyebrow: 'Get started',
      title: 'Download Fovea',
      note: 'Fovea works the moment it is installed — no account, no key, nothing to phone home for. The free plan runs Standard mode at 2× and ten enhancements a calendar month. Activating a key lifts those ceilings.',
    };
  }
  return {
    eyebrow: 'Almost there',
    title: `Thanks — here’s how to get ${tier.name}`,
    note: 'Keep your order confirmation. The steps below install the app and put this machine on the plan you paid for; the key does the rest, offline.',
  };
}

export default async function DownloadPage(props: {
  searchParams: Promise<{
    tier?: string;
    source?: string;
    session_id?: string;
    order_id?: string;
    ref?: string;
  }>;
}) {
  const {
    tier: tierParam,
    session_id: sessionId,
    order_id: orderId,
    ref: refParam,
  } = await props.searchParams;
  const tier = findTier(tierParam);
  const h = heading(tier);
  const dl = downloadInfo();
  const facts = planFacts[planKey(tier)];
  const paid = tier !== undefined && tier.id !== 'evaluate';
  // The button downloads the build branded for the plan this visit is about.
  const plan: PlanId = paid ? (tier!.id as PlanId) : 'free';
  const build = dl.builds[plan];
  const others = (['free', 'pro', 'studio'] as PlanId[]).filter(
    (p) => p !== plan && dl.builds[p].published,
  );

  // Stripe returns the buyer with the Checkout Session id; Dodo and Lemon Squeezy
  // with the reference id our checkout minted (a provider's own order id can be
  // too small to be a secret). Either is a random string only the buyer and the
  // provider know, so it doubles as the lookup token for the license the webhook
  // claimed on payment — and it is exactly the `external_id` that handler stored.
  const orderRef = sessionId ?? refParam ?? orderId;
  const order: OrderRow | null =
    orderRef && supabaseConfigured()
      ? await getOrderByExternalId(orderRef).catch(() => null)
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
            {build.published ? (
              <div className="flex flex-wrap items-center gap-4">
                <a
                  href={build.exeUrl ?? '#'}
                  className="inline-flex items-center gap-2 rounded-pill bg-white px-7 py-3.5 text-[1rem] font-semibold text-canvas shadow-soft transition hover:-translate-y-0.5"
                >
                  Download {build.name} for Windows
                  {build.size ? <span className="text-canvas/60">· {build.size}</span> : null}
                </a>
                {build.msiUrl ? (
                  <a
                    href={build.msiUrl}
                    className="inline-flex items-center gap-2 rounded-pill px-5 py-3.5 text-[0.95rem] font-semibold text-white ring-1 ring-white/30 transition hover:ring-white/60"
                  >
                    MSI package
                  </a>
                ) : null}
                <div className="text-sm text-steel-light">
                  {dl.version ? `Version ${dl.version} · ` : ''}Windows 10 &amp; 11, 64-bit
                </div>
              </div>
            ) : (
              <div className="rounded-card border border-white/15 bg-canvas-2/60 p-6">
                <p className="font-semibold text-white">
                  The {build.name} build isn’t published yet.
                </p>
                <p className="mt-2 text-[0.95rem] leading-relaxed text-steel-light">
                  This is a pre-launch note, not a broken link. When a build is uploaded, the
                  download button and its direct link appear here automatically. What you bought and
                  the activation steps below are already accurate.
                </p>
              </div>
            )}
            {others.length > 0 ? (
              <p className="mt-4 text-sm text-steel-light">
                The same engine, branded for another plan:{' '}
                {others.map((p, i) => (
                  <span key={p}>
                    {i > 0 ? ', ' : ''}
                    <a
                      href={dl.builds[p].exeUrl ?? '#'}
                      className="font-semibold text-white underline decoration-white/30 underline-offset-4 transition hover:decoration-white"
                    >
                      {dl.builds[p].name}
                    </a>
                  </span>
                ))}
                . A key moves a machine between plans, so switching builds never costs a
                reactivation.
              </p>
            ) : null}
          </Reveal>

          <Reveal className="mt-10" delay={140}>
            <div className="rounded-card border border-white/15 bg-canvas-2/50 p-6 sm:p-7">
              <h2 className="font-display text-xl font-semibold text-white">
                {paid
                  ? `${tier?.name} runs this on your machine`
                  : 'The free plan runs this on your machine'}
              </h2>
              <dl className="mt-5 grid gap-x-10 gap-y-2 sm:grid-cols-2">
                {facts.map((f) => (
                  <div
                    key={f.k}
                    className="flex items-baseline justify-between gap-4 border-b border-white/10 pb-2"
                  >
                    <dt className="text-[0.78rem] font-semibold uppercase tracking-[0.1em] text-steel">
                      {f.k}
                    </dt>
                    <dd className="text-right text-[0.95rem] font-semibold text-white">{f.v}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-5 text-[0.9rem] leading-relaxed text-steel-light">
                {paid
                  ? 'Settings → License shows this month’s count and the edition in force. Nothing phones home: the key is verified on the machine, and the ceiling lifts the moment it is accepted.'
                  : 'Settings → License shows how many of this month’s ten you have used — and pasting a key there lifts the ceiling without reinstalling anything.'}
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* What they purchased */}
      {paid && (
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
                    A key beginning <code className="rounded bg-sunken px-1">FOVEA1.</code> is
                    issued with your order and delivered by your purchase channel. Keep the
                    confirmation email — the key is how you activate below.
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
            <h2 className="font-display text-2xl font-semibold sm:text-3xl">
              Activate in a minute
            </h2>
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
              A key changes the ceiling, not the engine: import, Standard mode at 2×, batch, history
              and every export format run with nothing entered at all. Activating adds 4×, the
              Natural and Detail modes, the Portrait look and an uncapped month. Deactivating drops
              back to the free limits, and every image you have already made stays exactly as it is.
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
