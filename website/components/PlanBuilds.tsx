import type { DownloadInfo, PlanId, TierBuild } from '@/lib/download';
import { planFacts, tiers, type Tier } from '@/lib/site';
import { Cta } from './Cta';
import { Reveal } from './Reveal';
import { Check } from './SectionBits';

/**
 * The three branded installs, side by side, each with its own download and the
 * ceiling that build actually ships with.
 *
 * One engine is published as three named builds, so the download page cannot
 * offer a single button: which box you open is which plan you are on. Pro sits
 * in the centre as the preferred choice, and every card states its features
 * from the same tables the pricing section reads — a build never claims a
 * ceiling the app refuses to enforce.
 */
type Choice = {
  plan: PlanId;
  /** Which row of `tiers` / `planFacts` this build's claims come from. */
  tierId: 'evaluate' | 'pro' | 'studio';
  featured: boolean;
  hook: string;
};

const CHOICES: Choice[] = [
  {
    plan: 'free',
    tierId: 'evaluate',
    featured: false,
    hook: 'Install it, open it, run it. Nothing to enter, nothing to renew.',
  },
  {
    plan: 'pro',
    tierId: 'pro',
    featured: true,
    hook: 'The whole engine, on one machine, for as long as you keep it.',
  },
  {
    plan: 'studio',
    tierId: 'studio',
    featured: false,
    hook: 'Everything Pro across a team, with the engine controls exposed.',
  },
];

const tierById = new Map(tiers.map((t) => [t.id, t]));

/** The three ceilings that actually differ between builds. */
const CEILING_ROWS = ['Scale', 'Modes', 'Enhancements'] as const;

function Download({ build, featured }: { build: TierBuild; featured: boolean }) {
  if (!build.published) {
    return (
      <div
        className={`rounded-lg border px-4 py-3 text-[0.85rem] leading-relaxed ${
          featured ? 'border-white/20 text-steel-light' : 'border-line text-ink-3'
        }`}
      >
        <span className="font-semibold">Pre-launch note, not a broken link.</span> When this build
        is uploaded, its button and direct link appear here automatically.
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {/* A grid item stretches, which turns the inline Cta into a full-width bar. */}
      <div className="grid">
        <Cta href={build.exeUrl!} variant={featured ? 'light' : 'primary'}>
          Download {build.name}
          {build.size ? <span className="opacity-70">· {build.size}</span> : null}
        </Cta>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.85rem]">
        {build.msiUrl ? (
          <a
            href={build.msiUrl}
            className={`font-semibold underline underline-offset-4 transition-opacity hover:opacity-70 ${
              featured ? 'text-white/90 decoration-white/40' : 'text-accent decoration-accent/40'
            }`}
          >
            MSI package
          </a>
        ) : null}
        <span className={featured ? 'text-steel-light' : 'text-ink-3'}>
          Windows 10 &amp; 11, 64-bit
        </span>
      </div>
    </div>
  );
}

export function PlanBuilds({
  dl,
  current,
}: {
  dl: DownloadInfo;
  /** The plan this visit is about, so the build a buyer paid for is marked. */
  current: PlanId;
}) {
  return (
    <div id="builds">
      <div className="grid items-stretch gap-6 lg:grid-cols-3 lg:gap-8">
        {CHOICES.map((choice, i) => {
          const tier: Tier = tierById.get(choice.tierId)!;
          const build = dl.builds[choice.plan];
          const isCurrent = choice.plan === current;
          const featured = choice.featured;
          return (
            <Reveal key={choice.plan} delay={featured ? 0 : i * 110} className="h-full">
              <div
                className="plan-card"
                data-featured={featured || undefined}
                data-current={isCurrent || undefined}
              >
                {featured ? (
                  <span className="plan-badge">Most popular</span>
                ) : isCurrent ? (
                  <span className="plan-badge plan-badge-quiet">Your build</span>
                ) : null}

                <div className="flex flex-1 flex-col gap-5 p-7 sm:p-8">
                  <div>
                    <h3 className="font-display text-[1.35rem] font-semibold leading-tight">
                      {build.name}
                    </h3>
                    <div className="mt-3 flex items-baseline gap-2">
                      <span className="font-display text-4xl font-semibold">{tier.price}</span>
                      <span
                        className={`text-[0.95rem] ${featured ? 'text-steel-light' : 'text-ink-3'}`}
                      >
                        {tier.cadence}
                      </span>
                    </div>
                    <p className="plan-hook mt-4 text-[0.95rem] leading-relaxed">{choice.hook}</p>
                    <p
                      className={`mt-4 text-[0.78rem] font-semibold uppercase tracking-[0.1em] ${
                        featured ? 'text-white' : 'text-ink'
                      }`}
                    >
                      {tier.seats}
                    </p>
                  </div>

                  <ul className="flex-1 space-y-2.5 text-[0.92rem]">
                    {tier.highlights.map((h) => (
                      <li key={h} className="flex gap-3">
                        <Check light={featured} />
                        <span className={featured ? 'text-white/90' : 'text-ink-2'}>{h}</span>
                      </li>
                    ))}
                  </ul>

                  <Download build={build} featured={featured} />

                  <dl
                    className={`space-y-1.5 border-t pt-4 text-[0.85rem] ${
                      featured ? 'border-white/15' : 'border-line'
                    }`}
                  >
                    {planFacts[choice.tierId]
                      .filter((f) => (CEILING_ROWS as readonly string[]).includes(f.k))
                      .map((f) => (
                        <div key={f.k} className="flex items-baseline justify-between gap-4">
                          <dt
                            className={`text-[0.72rem] font-semibold uppercase tracking-[0.1em] ${
                              featured ? 'text-steel-light' : 'text-ink-3'
                            }`}
                          >
                            {f.k}
                          </dt>
                          <dd
                            className={`text-right font-semibold ${featured ? 'text-white' : 'text-ink'}`}
                          >
                            {f.v}
                          </dd>
                        </div>
                      ))}
                    <p
                      className={`pt-2 leading-relaxed ${featured ? 'text-steel-light' : 'text-ink-3'}`}
                    >
                      {choice.plan === 'free'
                        ? 'No key, no account — and pasting one in Settings later lifts the ceiling without reinstalling.'
                        : 'Needs the FOVEA1. key from your purchase, pasted once into Settings → License. Activation runs on your machine, offline.'}
                    </p>
                  </dl>
                </div>
              </div>
            </Reveal>
          );
        })}
      </div>

      <p className="mx-auto mt-12 max-w-2xl text-center text-[0.92rem] leading-relaxed text-ink-2">
        Three names on one engine, so the app you open is the plan you are on
        {dl.version ? ` — version ${dl.version}` : ''}. A key moves a machine between plans, and
        switching builds never costs a reactivation; your history, batch queue and every image you
        have made stay exactly as they are.
      </p>
    </div>
  );
}
