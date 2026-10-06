/**
 * POST /api/webhooks/dodo — Dodo Payments' only way in, and the fulfillment
 * endpoint for the processor the site sells through. On a confirmed payment it
 * promotes the pending order and atomically hands out one pre-issued license
 * key from the Supabase pool (`claim_license_key` RPC). Like the Stripe and
 * Lemon Squeezy routes it never mints a key — the Ed25519 signing secret lives
 * only with the offline vendor tool.
 *
 * Request authenticity: Dodo follows the Standard Webhooks spec. The signed
 * content is `{webhook-id}.{webhook-timestamp}.{raw body}`, keyed with the
 * endpoint secret (base64 of the part after `whsec_`), HMAC-SHA256, base64'd,
 * and compared against the space-separated `v1,<base64>` entries of
 * `webhook-signature`. The raw body is authenticated before the JSON is read,
 * and a timestamp more than five minutes off is rejected, so a captured
 * delivery cannot be replayed.
 *
 * Order identity comes from `data.metadata.ref` — the random id our checkout
 * minted and that rode through the hosted checkout as session metadata. That,
 * not Dodo's payment id, is the primary key, so the row the checkout wrote is
 * the row payment fulfills. Idempotency is by that key: a retried delivery of
 * the same event re-reads the order and never claims a second key.
 *
 * Brand safety: a Dodo business can hold several brands, and Fovea shares its
 * business with Caelmont/Veyra. Webhook endpoints are registered per business
 * with no brand filter, so this route receives the other brand's payments too.
 * `business_id` alone cannot tell them apart, so fulfillment additionally
 * requires the paid cart to contain a product id from the Fovea catalog (and,
 * when Dodo sends one, a matching `brand_id`). Client-echoed `metadata.tier`
 * is never sufficient on its own.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  claimLicenseKey,
  fulfillOrder,
  getOrdersByDodoPayment,
  getOrderByExternalId,
  mergeOrderMetadata,
  setOrderStatus,
  supabaseConfigured,
  upsertOrder,
  type OrderRow,
  type OrderTier,
} from '@/lib/supabase';
import { TIER_EDITION } from '@/lib/commerce';
import { isFoveaDodoProduct, tierForDodoProduct } from '@/lib/providers/dodo';

const REPLAY_WINDOW_SECONDS = 5 * 60;

function header(req: NextRequest, name: string): string {
  return req.headers.get(name) ?? '';
}

/** Standard Webhooks verification, per Dodo's documented algorithm. */
function verifySignature(req: NextRequest, body: string, secret: string): boolean {
  const id = header(req, 'webhook-id');
  const timestamp = header(req, 'webhook-timestamp');
  const signatures = header(req, 'webhook-signature');
  if (!id || !timestamp || !signatures) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_SECONDS) return false;

  // The secret is base64; `whsec_` is a label, not part of the key.
  const secretBody = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(secretBody, 'base64');
  if (key.length === 0) return false;

  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return (
    signatures
      .split(' ')
      .map((entry) => entry.split(','))
      .filter(([version, value]) => version === 'v1' && !!value)
      .map(([, value]) => Buffer.from(value, 'base64'))
      // Length must match before timingSafeEqual (it throws otherwise).
      .filter((buf) => buf.length === expected.length)
      .some((buf) => timingSafeEqual(buf, expected))
  );
}

/** The subset of a Dodo event envelope this endpoint understands. */
type DodoEvent = {
  business_id?: string;
  brand_id?: string;
  type?: string;
  data?: {
    payload_type?: string;
    brand_id?: string;
    payment_id?: string;
    status?: string;
    total_amount?: number;
    currency?: string;
    checkout_session_id?: string | null;
    metadata?: Record<string, unknown> | null;
    customer?: { email?: string } | null;
    product_cart?: { product_id?: string }[] | null;
  };
};

/**
 * Which tier this payment buys. The paid cart is the authority: a tier that
 * merely appears in checkout metadata, with a cart of another brand's products,
 * is the other brand's sale and must not consume a Fovea license.
 */
function resolveTier(event: DodoEvent): OrderTier | null {
  const cart = event.data?.product_cart;
  const cartTier = (cart ?? [])
    .map((item) => tierForDodoProduct(item?.product_id))
    .find((tier): tier is OrderTier => tier !== null);
  if (cartTier) return cartTier;

  const custom = event.data?.metadata?.tier;
  const declared = custom === 'pro' || custom === 'studio' ? custom : null;
  // A cart we did not recognize is a different brand's payment — metadata cannot override it.
  if (Array.isArray(cart) && cart.some((item) => !isFoveaDodoProduct(item?.product_id)))
    return null;
  return declared;
}

/** True when Dodo told us which brand was paid and it is not Fovea's. */
function isOtherBrand(event: DodoEvent): boolean {
  const expected = process.env.FOVEA_DODO_BRAND_ID?.trim();
  if (!expected) return false;
  const paid = event.brand_id ?? event.data?.brand_id;
  return typeof paid === 'string' && paid !== '' && paid !== expected;
}

/** Our checkout-time reference id. */
function resolveRef(event: DodoEvent): string | null {
  const ref = event.data?.metadata?.ref;
  return typeof ref === 'string' && ref ? ref : null;
}

/**
 * Fulfill a succeeded payment: promote (or create) the row keyed by our
 * reference id, claim a key of the right edition, mark it fulfilled. Idempotent:
 * an already-fulfilled order is returned as-is and never double-claimed.
 */
async function fulfill(event: DodoEvent): Promise<OrderRow | null> {
  const data = event.data ?? {};
  const externalId = resolveRef(event);
  const tier = resolveTier(event);
  if (!externalId || !tier) {
    console.error('[dodo-webhook] paid event missing ref or resolvable tier', data.payment_id);
    return null;
  }

  // Dodo reports total_amount in the currency's smallest unit (cents), which is
  // exactly the scale the orders column stores.
  const paymentId = typeof data.payment_id === 'string' ? data.payment_id : null;
  let order = await getOrderByExternalId(externalId);
  if (order?.status === 'fulfilled') {
    return order;
  }
  if (order) {
    // The row predates payment; record the Dodo payment id so a later refund
    // event can find it.
    if (paymentId) {
      await mergeOrderMetadata(order.id, { payment_id: paymentId }).catch(() => {});
    }
  } else {
    order = await upsertOrder({
      provider: 'dodo',
      external_id: externalId,
      tier,
      edition: TIER_EDITION[tier]!,
      email: data.customer?.email ?? null,
      amount_total: typeof data.total_amount === 'number' ? data.total_amount : null,
      currency: data.currency ?? null,
      status: 'paid',
      metadata: {
        payment_id: paymentId,
        checkout_session_id: data.checkout_session_id ?? null,
      },
    });
    if (!order) {
      console.error(`[dodo-webhook] ${externalId}: could not record the paid order`);
      return null;
    }
  }

  // A dry pool is permanent, not an error: the order stays 'paid' so the vendor
  // sees it in Supabase and delivers a key by hand. Never swallow a paid order.
  const license = await claimLicenseKey(TIER_EDITION[tier]!, order.id);
  if (!license) {
    console.error(`[dodo-webhook] ${externalId}: license pool empty for edition ${tier}`);
    return order;
  }

  await fulfillOrder(order.id, license);
  console.log(
    `[dodo-webhook] ${externalId}: fulfilled ${tier} order for ${data.customer?.email ?? 'unknown email'}`,
  );
  return { ...order, status: 'fulfilled', license_key: license.key, license_id: license.licenseId };
}

export async function POST(req: NextRequest) {
  const secret = process.env.FOVEA_DODO_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }

  // Authenticate before parsing: an unsigned probe must not reach fulfillment.
  const payload = await req.text();
  if (!verifySignature(req, payload, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: 'database not configured' }, { status: 503 });
  }

  let event: DodoEvent;
  try {
    event = JSON.parse(payload) as DodoEvent;
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  // A test-mode business sends to the same URL. Its payments are not real
  // sales, so they must not consume a license from the pool.
  const expectedBusiness = process.env.FOVEA_DODO_BUSINESS_ID?.trim();
  if (expectedBusiness && event.business_id !== expectedBusiness) {
    console.warn(
      `[dodo-webhook] ignored ${event.type} from business ${event.business_id} (expected ${expectedBusiness})`,
    );
    return NextResponse.json({ received: true, ignored: 'other business' });
  }

  // Same business, different brand: Caelmont/Veyra payments arrive here too and
  // are none of this endpoint's business.
  if (isOtherBrand(event)) {
    console.warn(
      `[dodo-webhook] ignored ${event.type} from brand ${event.brand_id ?? event.data?.brand_id}`,
    );
    return NextResponse.json({ received: true, ignored: 'other brand' });
  }

  const type = event.type ?? '';
  try {
    switch (type) {
      case 'payment.succeeded': {
        // status is a belt to the signature's braces: only a settled payment
        // delivers a license.
        if (event.data?.status === 'succeeded') await fulfill(event);
        break;
      }
      case 'payment.failed':
      case 'payment.cancelled': {
        const externalId = resolveRef(event);
        if (externalId) {
          const order = await getOrderByExternalId(externalId).catch(() => null);
          if (order && order.status === 'pending') await setOrderStatus(order.id, 'canceled');
        }
        break;
      }
      case 'refund.succeeded': {
        const paymentId = event.data?.payment_id;
        if (typeof paymentId === 'string' && paymentId) {
          const rows = await getOrdersByDodoPayment(paymentId).catch(() => []);
          for (const order of rows) await setOrderStatus(order.id, 'refunded');
        }
        break;
      }
      default:
        break; // unknown event types are acknowledged, not errors
    }
  } catch (err) {
    // Non-2xx makes Dodo retry the delivery — right behavior for a transient DB
    // outage; idempotency by reference id keeps a retried fulfillment safe.
    console.error(`[dodo-webhook] ${type} failed`, err);
    return NextResponse.json({ error: 'processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
