import type { CheckoutRequest, CheckoutResult, PaymentProvider } from '../commerce';

/**
 * The default, secret-free provider. It makes no network call and mints
 * nothing. When no payment processor is wired, a "purchase" is recorded only
 * as an intent to continue to delivery, and the browser is handed to the
 * download + activation page on this same site.
 *
 * This is the honest launch state: Pixora can be downloaded and its
 * enhancement used immediately (nothing is gated), and a license key is
 * issued vendor-side and delivered by the chosen channel. A real processor
 * replaces this with a `redirect` to its hosted checkout — see the sibling
 * `stripe` adapter for the exact shape that swap takes.
 */
export class ManualProvider implements PaymentProvider {
  readonly id = 'manual';

  async startCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    const url = new URL('/download', req.successUrl);
    url.searchParams.set('tier', req.tier);
    url.searchParams.set('source', 'checkout');
    return { kind: 'manual', redirectTo: `${url.pathname}${url.search}` };
  }
}
