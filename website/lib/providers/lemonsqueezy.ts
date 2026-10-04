/**
 * Lemon Squeezy adapter — a second real online-processor implementation of the
 * PaymentProvider seam in ../commerce.ts.
 *
 * How a purchase flows:
 *   1. Buyer clicks Buy → /api/checkout?tier=… → startCheckout() below.
 *   2. We mint a random reference id, record a 'pending' order keyed by it, and
 *      redirect straight to that tier's Lemon Squeezy Fast Link — a checkout
 *      page hosted by Lemon Squeezy (cards, PayPal, local methods, and global
 *      sales-tax/VAT remittance are their job, not ours). No payment API call
 *      is needed to *start* a sale here, unlike Stripe.
 *   3. The reference id rides through the checkout as custom data and back in
 *      the webhook, so fulfillment can find our pending row, and it is echoed
 *      in the buyer's post-payment redirect so /download can show the key.
 *   4. Lemon Squeezy calls /api/webhooks/lemonsqueezy on payment; it verifies
 *      the X-Signature HMAC and atomically claims a license key from the
 *      pre-issued pool. The signing secret never comes near this server — keys
 *      exist before the sale, minted offline.
 *
 * Why the reference id is ours, not Lemon Squeezy's: their order id is a small
 * integer, so a delivery page keyed on it would let anyone enumerate other
 * buyers' keys. A random token only the buyer's own redirect carries is the
 * same unguessable lookup secret Stripe's session id gives us.
 *
 * Secrets + config (server-side only, never shipped to the browser):
 *   FOVEA_LS_FASTLINK_PRO / _STUDIO  — the hosted checkout URLs
 *   FOVEA_LS_WEBHOOK_SECRET          — webhook route only (X-Signature HMAC)
 *   FOVEA_LS_VARIANT_PRO / _STUDIO   — variant ids, a fallback tier signal for
 *      webhooks that somehow lack our custom_data
 */

import { randomUUID } from 'node:crypto';
import type { CheckoutRequest, CheckoutResult, PaymentProvider } from '../commerce';
import { TIER_EDITION } from '../commerce';
import { ProviderConfigError } from './stripe';
import { supabaseConfigured, upsertOrder } from '../supabase';

export class LemonSqueezyProvider implements PaymentProvider {
  readonly id = 'lemonsqueezy';

  async startCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    if (req.tier === 'evaluate') {
      throw new Error(`tier "${req.tier}" is free and never goes through a payment provider`);
    }
    const envKey = `FOVEA_LS_FASTLINK_${req.tier.toUpperCase()}`;
    const link = process.env[envKey]?.trim();
    if (!link) throw new ProviderConfigError(envKey);

    const ref = randomUUID();
    const origin = new URL(req.successUrl).origin;
    const target = new URL(link);
    // Ride our reference through Lemon Squeezy and back (meta.custom_data), and
    // send the buyer home with it so /download can reveal the claimed key.
    target.searchParams.set('checkout[custom][ref]', ref);
    target.searchParams.set('checkout[custom][tier]', req.tier);
    target.searchParams.set(
      'redirect_url',
      `${origin}/download?tier=${req.tier}&source=lemonsqueezy&ref=${ref}`,
    );

    // Record the intent so the webhook has a pending row to promote. Failure
    // here must never block the sale: the webhook creates the row itself on
    // payment if this write was skipped.
    if (supabaseConfigured()) {
      try {
        await upsertOrder({
          provider: 'lemonsqueezy',
          external_id: ref,
          tier: req.tier,
          edition: TIER_EDITION[req.tier]!,
        });
      } catch (err) {
        console.error('[lemonsqueezy] pending order not recorded:', err);
      }
    }

    return { kind: 'redirect', url: target.toString() };
  }
}
