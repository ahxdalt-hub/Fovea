/**
 * Stripe Checkout adapter — the real online-processor implementation of the
 * PaymentProvider seam in ../commerce.ts.
 *
 * How a purchase flows:
 *   1. Buyer clicks Buy → /api/checkout?tier=… → startCheckout() below.
 *   2. We create a Stripe Checkout Session (one-time payment) over Stripe's
 *      REST API and return its hosted page URL as a redirect.
 *   3. We record a 'pending' order in Supabase keyed by the session id. If
 *      that write fails, checkout still proceeds — the webhook inserts the
 *      row when Stripe confirms.
 *   4. Stripe calls /api/webhooks/stripe on payment, which verifies the
 *      signature, marks the order paid, and atomically claims a license key
 *      from the pre-issued pool.
 *   5. The buyer lands on /download?…&session_id=… which shows the claimed
 *      key. The signing secret stays with the vendor tool, always offline.
 *
 * Secrets used (server-side only, never shipped to the browser):
 *   FOVEA_STRIPE_SECRET_KEY      — sk_… (Checkout Session creation)
 *   FOVEA_STRIPE_PRICE_PRO / _STUDIO — optional pre-created Stripe Price ids;
 *      when absent, a price is created inline from FOVEA_STRIPE_AMOUNT_*
 *      (in USD) so the site works before any Stripe Products are set up.
 *   FOVEA_STRIPE_WEBHOOK_SECRET  — whsec_… (webhook route only)
 */

import type { CheckoutRequest, CheckoutResult, PaymentProvider } from '../commerce';
import { TIER_EDITION, type TierId } from '../commerce';
import { supabaseConfigured, upsertOrder } from '../supabase';

/** Thrown when the provider is selected but its secrets are missing. */
export class ProviderConfigError extends Error {
  constructor(missing: string) {
    super(`Stripe provider is selected but ${missing} is not set`);
  }
}

const API = 'https://api.stripe.com/v1';

type StripeSession = {
  id: string;
  object: 'checkout.session';
  url: string | null;
  payment_status?: string;
  amount_total?: number | null;
  currency?: string | null;
};

/** One-time price for a tier: pre-created Stripe Price id, else inline price_data. */
function priceParams(tier: TierId, form: URLSearchParams): void {
  const priceId = process.env[`FOVEA_STRIPE_PRICE_${tier.toUpperCase()}`]?.trim();
  if (priceId) {
    form.set('line_items[0][price]', priceId);
    return;
  }
  const usd = Number(process.env[`FOVEA_STRIPE_AMOUNT_${tier.toUpperCase()}_USD`] ?? '');
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new ProviderConfigError(
      `FOVEA_STRIPE_PRICE_${tier.toUpperCase()} or FOVEA_STRIPE_AMOUNT_${tier.toUpperCase()}_USD`,
    );
  }
  form.set('line_items[0][price_data][currency]', 'usd');
  form.set('line_items[0][price_data][unit_amount]', String(Math.round(usd * 100)));
  form.set('line_items[0][price_data][product_data][name]', `Fovea ${tier === 'pro' ? 'Pro' : 'Studio'} (one-time)`);
}

export class StripeProvider implements PaymentProvider {
  readonly id = 'stripe';

  private secret(): string {
    const key = process.env.FOVEA_STRIPE_SECRET_KEY?.trim();
    if (!key) throw new ProviderConfigError('FOVEA_STRIPE_SECRET_KEY');
    return key;
  }

  async startCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    if (req.tier === 'evaluate') {
      throw new Error(`tier "${req.tier}" is free and never goes through a payment provider`);
    }
    const edition = TIER_EDITION[req.tier]!;
    const secret = this.secret();
    const origin = new URL(req.successUrl).origin;

    const form = new URLSearchParams();
    form.set('mode', 'payment');
    form.set('success_url', `${origin}/download?tier=${req.tier}&source=stripe&session_id={CHECKOUT_SESSION_ID}`);
    form.set('cancel_url', `${origin}/#pricing`);
    form.set('client_reference_id', req.tier);
    form.set('metadata[tier]', req.tier);
    form.set('allow_promotion_codes', 'true');
    form.set('line_items[0][quantity]', '1');
    priceParams(req.tier, form);

    const res = await fetch(`${API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Stripe checkout session failed (${res.status}): ${detail}`);
    }
    const session = (await res.json()) as StripeSession;
    if (!session.url) throw new Error('Stripe returned a session without a hosted page URL');

    // Record the intent. Failure here must never block the sale: the webhook
    // inserts the order row itself when Stripe confirms payment.
    if (supabaseConfigured()) {
      try {
        await upsertOrder({
          provider: 'stripe',
          external_id: session.id,
          tier: req.tier,
          edition,
          amount_total: session.amount_total ?? null,
          currency: session.currency ?? null,
        });
      } catch (err) {
        console.error('[stripe] pending order not recorded:', err);
      }
    }

    return { kind: 'redirect', url: session.url };
  }
}
