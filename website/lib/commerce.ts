/**
 * Commerce seam — the single, provider-agnostic boundary between "a customer
 * decides to buy" and "a Fovea license exists."
 *
 * Two rules keep this honest and safe:
 *
 * 1. The website never touches image data. It only starts a checkout. All
 *    enhancement stays inside the desktop app on the buyer's machine.
 * 2. The website never holds a signing secret. A license key is issued by the
 *    vendor tool (`examples/issue_license.rs`) with a private Ed25519 seed
 *    that is deliberately NOT present here. What comes back from a payment
 *    provider is a *delivery* (a hosted checkout redirect, an emailed key),
 *    never a key minted in the browser.
 *
 * Provider APIs change and differ, so none are hard-coded. A provider is a
 * tiny interface with one method; concrete adapters live in `./providers/*`
 * and are selected by env (`FOVEA_PAYMENT_PROVIDER`). The default provider
 * needs no secret and makes no network call — it records the intent and hands
 * the buyer to the download/activation flow, which is the truthful launch path
 * until a real processor is connected.
 */

import { ManualProvider } from './providers/manual';
import { LemonSqueezyProvider } from './providers/lemonsqueezy';
import { ProviderConfigError, StripeProvider } from './providers/stripe';

/** Which commercial product a checkout is for. Maps 1:1 to `tiers` in site.ts. */
export type TierId = 'pro' | 'studio' | 'evaluate';

/** The license edition a paid tier corresponds to (see services/license/key.rs). */
export type Edition = 'pro' | 'studio';

/**
 * Tier → edition mapping used everywhere the site and the desktop key format
 * meet. The free tier issues nothing; the app runs enhancement regardless
 * (Stage 13 guarantees no feature is gated). Keeping this table here means a
 * provider adapter never re-decides what "Pro" means.
 */
export const TIER_EDITION: Record<TierId, Edition | null> = {
  pro: 'pro',
  studio: 'studio',
  evaluate: null,
};

export type CheckoutRequest = {
  tier: TierId;
  /** Absolute site URL to hand the buyer to once we own the next step. */
  successUrl: string;
};

export type CheckoutResult =
  /** Send the browser to a provider-hosted payment page. */
  | { kind: 'redirect'; url: string }
  /** No online processor: continue straight to delivery on our own site. */
  | { kind: 'manual'; redirectTo: string };

export interface PaymentProvider {
  readonly id: string;
  startCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
}

/**
 * Resolve the configured provider from env at call time — not a module
 * constant, so a running server can change providers without a rebuild and so
 * importing this file never reads secrets eagerly. An unknown id falls back to
 * the safe, secret-free manual path rather than failing the customer.
 */
export function resolveProvider(): PaymentProvider {
  const id = (process.env.FOVEA_PAYMENT_PROVIDER ?? 'manual').trim().toLowerCase();
  switch (id) {
    // Real adapters (Paddle, Gumroad webhook, …) would get their own files
    // under ./providers/* and a case here.
    case 'stripe':
      return new StripeProvider();
    case 'lemonsqueezy':
      return new LemonSqueezyProvider();
    case 'manual':
    default:
      return new ManualProvider();
  }
}

/**
 * True when FOVEA_PAYMENT_PROVIDER names a provider that needs secrets and
 * those secrets are present. Used to fail loudly (never silently degrade to
 * the manual path, which would sell a license nobody delivers).
 */
export function providerIsConfigured(): boolean {
  const id = (process.env.FOVEA_PAYMENT_PROVIDER ?? 'manual').trim().toLowerCase();
  if (id === 'manual') return true;
  if (id === 'stripe') return !!process.env.FOVEA_STRIPE_SECRET_KEY?.trim();
  if (id === 'lemonsqueezy') {
    // A sale needs a Fast Link per paid tier to start, and needs the webhook
    // secret to be fulfilled — missing any of the three sells a license nobody
    // can deliver, so all three are required.
    return !!(
      process.env.FOVEA_LS_FASTLINK_PRO?.trim() &&
      process.env.FOVEA_LS_FASTLINK_STUDIO?.trim() &&
      process.env.FOVEA_LS_WEBHOOK_SECRET?.trim()
    );
  }
  return false;
}

export { ProviderConfigError };

/** The delivery location the manual flow (and post-checkout return) uses. */
export const DELIVERY_PATH = '/download';
