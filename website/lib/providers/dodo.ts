/**
 * Dodo Payments adapter — the processor Fovea sells through. A merchant of
 * record: cards, PayPal, local methods, VAT/sales tax and the payout are their
 * job, so nothing payment-shaped is stored or computed on this server.
 *
 * How a purchase flows:
 *   1. Buyer clicks Buy → /api/checkout?tier=… → startCheckout() below.
 *   2. We mint a random reference id, open a Dodo Checkout Session for that
 *      tier's catalog product, and redirect the buyer to its hosted page.
 *   3. The reference id rides through as session metadata and comes back in the
 *      `payment.succeeded` webhook, where fulfillment claims one pre-issued
 *      license key from the Supabase pool. The Ed25519 signing seed never comes
 *      near this server — keys exist before the sale, minted offline.
 *   4. Dodo sends the buyer back to /download?…&ref=… , which shows the key the
 *      webhook claimed (or says it is finalizing, if the webhook is a beat later).
 *
 * Why the reference id is ours, not Dodo's: the delivery page is keyed on a
 * random token only this buyer's own redirect carries, the same unguessable
 * lookup secret a Stripe session id gives us. Dodo's own ids are recorded on the
 * order row for refunds and support.
 *
 * Secrets + config (server-side only, never shipped to the browser):
 *   FOVEA_DODO_API_KEY         — the API key for the mode below (required)
 *   FOVEA_DODO_MODE            — 'live' (default) or 'test'; picks the API host,
 *     since a key only authenticates against its own host.
 *   FOVEA_DODO_PRODUCT_PRO / _STUDIO — catalog product ids (pdt_…). Created by
 *     `node scripts/dodo-setup.mjs`, which prints these values.
 *   FOVEA_DODO_BUSINESS_ID     — bus_…, checked on every webhook (see route)
 *   FOVEA_DODO_BRAND_ID        — brnd_…, the Fovea brand. The business also
 *     holds the Caelmont brand, whose payments arrive at this same endpoint.
 *   FOVEA_DODO_WEBHOOK_SECRET  — whsec_…, webhook route only
 */

import { randomUUID } from 'node:crypto';
import type { CheckoutRequest, CheckoutResult, PaymentProvider } from '../commerce';
import { TIER_EDITION } from '../commerce';
import { ProviderConfigError } from './stripe';
import { supabaseConfigured, upsertOrder } from '../supabase';

/** A test key does not authenticate against live, so the host follows the mode. */
export function dodoApiBase(): string {
  const mode = (process.env.FOVEA_DODO_MODE ?? 'live').trim().toLowerCase();
  return mode === 'test' ? 'https://test.dodopayments.com' : 'https://live.dodopayments.com';
}

function apiKey(): string {
  const key = process.env.FOVEA_DODO_API_KEY?.trim();
  if (!key) throw new ProviderConfigError('FOVEA_DODO_API_KEY');
  return key;
}

/** The catalog product sold for a tier. Also the webhook's tier fallback. */
export function dodoProductId(tier: 'pro' | 'studio'): string {
  const envKey = `FOVEA_DODO_PRODUCT_${tier.toUpperCase()}`;
  const id = process.env[envKey]?.trim();
  if (!id) throw new ProviderConfigError(envKey);
  return id;
}

/** Tier from a product id, for a webhook whose metadata somehow lacks `tier`. */
export function tierForDodoProduct(productId: unknown): 'pro' | 'studio' | null {
  const id = productId == null ? '' : String(productId);
  if (!id) return null;
  if (process.env.FOVEA_DODO_PRODUCT_PRO?.trim() === id) return 'pro';
  if (process.env.FOVEA_DODO_PRODUCT_STUDIO?.trim() === id) return 'studio';
  return null;
}

/**
 * Whether this product id is in the Fovea catalog. Webhook endpoints are
 * registered per business, and this business also sells another brand's
 * products, so a payment for anything else has to be ignored rather than
 * fulfilled — an unrecognized id is proof it is not ours.
 */
export function isFoveaDodoProduct(productId: unknown): boolean {
  return tierForDodoProduct(productId) !== null;
}

type DodoCheckoutResponse = {
  session_id?: string;
  checkout_url?: string | null;
};

export class DodoProvider implements PaymentProvider {
  readonly id = 'dodo';

  async startCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    if (req.tier !== 'pro' && req.tier !== 'studio') {
      throw new Error(`tier "${req.tier}" is free and never goes through a payment provider`);
    }
    const tier = req.tier;
    const productId = dodoProductId(tier);
    const ref = randomUUID();
    const origin = new URL(req.successUrl).origin;

    const res = await fetch(`${dodoApiBase()}/checkouts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        product_cart: [{ product_id: productId, quantity: 1 }],
        // A UI hint only — the buyer landing here proves nothing. Fulfillment
        // waits for the signed webhook, as Dodo's own docs require.
        return_url: `${origin}/download?tier=${tier}&source=dodo&ref=${ref}`,
        cancel_url: `${origin}/#pricing`,
        metadata: { ref, tier },
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Dodo checkout session failed (${res.status}): ${detail}`);
    }
    const session = (await res.json()) as DodoCheckoutResponse;
    if (!session.checkout_url) {
      throw new Error(`Dodo returned session ${session.session_id ?? '?'} without a checkout_url`);
    }

    // Record the intent so the webhook has a pending row to promote. Failure
    // here must never block the sale: the webhook creates the row itself on
    // payment if this write was skipped.
    if (supabaseConfigured()) {
      try {
        await upsertOrder({
          provider: 'dodo',
          external_id: ref,
          tier,
          edition: TIER_EDITION[tier]!,
          metadata: { dodo_session_id: session.session_id ?? null },
        });
      } catch (err) {
        console.error('[dodo] pending order not recorded:', err);
      }
    }

    return { kind: 'redirect', url: session.checkout_url };
  }
}
