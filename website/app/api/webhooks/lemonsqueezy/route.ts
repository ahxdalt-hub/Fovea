/**
 * POST /api/webhooks/lemonsqueezy — Lemon Squeezy's only way in, the fulfillment
 * endpoint for that provider. On confirmed payment it promotes the pending order
 * and atomically hands out one pre-issued license key from the Supabase pool
 * (`claim_license_key` RPC). Like the Stripe route it never mints a key — the
 * Ed25519 signing secret lives only with the offline vendor tool.
 *
 * Request authenticity: Lemon Squeezy sends `X-Signature`, the hex HMAC-SHA256
 * of the raw request body keyed with the webhook secret. The raw body is
 * authenticated with a constant-time compare BEFORE the JSON is read, so an
 * unsigned probe learns nothing. This scheme has no signed timestamp, so replay
 * protection is idempotency: the order is keyed by our own reference id and a
 * fulfilled order is never claimed twice.
 *
 * Order identity comes from `meta.custom_data.ref` — the random id our provider
 * minted at checkout and that rode through Lemon Squeezy as custom data. That,
 * not Lemon Squeezy's small integer order id, is the primary key, so the same
 * row the checkout wrote is the row payment fulfills.
 *
 * Amounts: Lemon Squeezy reports `total` in major currency units (e.g. 1859.76),
 * whereas the orders table stores cents (Stripe's unit). It is normalised here so
 * both providers land in one column on one scale.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  claimLicenseKey,
  fulfillOrder,
  getOrderByExternalId,
  setOrderStatus,
  supabaseConfigured,
  upsertOrder,
  type OrderRow,
  type OrderTier,
} from '@/lib/supabase';
import { TIER_EDITION } from '@/lib/commerce';

function verifySignature(payload: string, header: string, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac('sha256', secret).update(payload, 'utf8').digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(header, 'hex');
  } catch {
    return false;
  }
  // Length must match before timingSafeEqual (it throws otherwise); a wrong
  // length is simply a rejected signature.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** The subset of a Lemon Squeezy order event this endpoint understands. */
type LsOrderEvent = {
  meta?: { event_name?: string; custom_data?: Record<string, unknown> | null };
  data?: {
    id?: string;
    attributes?: {
      identifier?: string;
      user_email?: string;
      total?: number;
      currency?: string;
      status?: string;
      test_mode?: boolean;
      first_order_item?: { variant_id?: number | string };
    };
  };
};

/**
 * Map a variant id to a tier via env — only a fallback when our own custom_data
 * is absent, since a Fast Link otherwise gives us no product signal.
 */
function tierFromVariant(variantId: unknown): OrderTier | null {
  const id = variantId == null ? '' : String(variantId);
  if (!id) return null;
  if (process.env.FOVEA_LS_VARIANT_PRO?.trim() === id) return 'pro';
  if (process.env.FOVEA_LS_VARIANT_STUDIO?.trim() === id) return 'studio';
  return null;
}

function resolveTier(event: LsOrderEvent): OrderTier | null {
  const custom = event.meta?.custom_data?.tier;
  if (custom === 'pro' || custom === 'studio') return custom;
  return tierFromVariant(event.data?.attributes?.first_order_item?.variant_id);
}

/** Our checkout-time reference id; falls back to the order's UUID identifier. */
function resolveRef(event: LsOrderEvent): string | null {
  const ref = event.meta?.custom_data?.ref;
  if (typeof ref === 'string' && ref) return ref;
  return event.data?.attributes?.identifier ?? null;
}

/** Lemon Squeezy total is in major units; the orders column is cents. */
function toCents(total: unknown): number | null {
  return typeof total === 'number' && Number.isFinite(total) ? Math.round(total * 100) : null;
}

/**
 * Fulfill a paid order: promote (or create) the row keyed by our reference id,
 * claim a key of the right edition, mark it fulfilled. Returns the order row (or
 * null when the pool is dry). Idempotent: an already-fulfilled order is returned
 * as-is and never double-claimed.
 */
async function fulfill(event: LsOrderEvent): Promise<OrderRow | null> {
  const attrs = event.data?.attributes ?? {};
  const externalId = resolveRef(event);
  const tier = resolveTier(event);
  if (!externalId || !tier) {
    console.error('[ls-webhook] paid order missing ref or resolvable tier', externalId);
    return null;
  }

  let order = await getOrderByExternalId(externalId);
  if (order?.status === 'fulfilled') {
    // A retried or duplicate event: deliver the key already claimed, never a
    // second one.
    return order;
  }
  if (!order) {
    order = await upsertOrder({
      provider: 'lemonsqueezy',
      external_id: externalId,
      tier,
      edition: TIER_EDITION[tier]!,
      email: attrs.user_email ?? null,
      amount_total: toCents(attrs.total),
      currency: attrs.currency ?? null,
      status: 'paid',
      metadata: { ls_order_id: event.data?.id ?? null },
    });
    if (!order) {
      console.error(`[ls-webhook] ${externalId}: could not record the paid order`);
      return null;
    }
  }

  // A dry pool is permanent, not an error: the order stays 'paid' so the vendor
  // sees it in Supabase and delivers a key by hand. Never swallow a paid order.
  const license = await claimLicenseKey(TIER_EDITION[tier]!, order.id);
  if (!license) {
    console.error(`[ls-webhook] ${externalId}: license pool empty for edition ${tier}`);
    return order;
  }

  await fulfillOrder(order.id, license);
  console.log(
    `[ls-webhook] ${externalId}: fulfilled ${tier} order for ${attrs.user_email ?? 'unknown email'}`,
  );
  return { ...order, status: 'fulfilled', license_key: license.key, license_id: license.licenseId };
}

export async function POST(req: NextRequest) {
  const secret = process.env.FOVEA_LS_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }

  // Authenticate before parsing: an unsigned probe must not reach fulfillment.
  const payload = await req.text();
  if (!verifySignature(payload, req.headers.get('x-signature') ?? '', secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: 'database not configured' }, { status: 503 });
  }

  let event: LsOrderEvent;
  try {
    event = JSON.parse(payload) as LsOrderEvent;
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  const name = event.meta?.event_name ?? '';
  // Sandbox orders drain nothing and a test key is not a product that sold.
  const isTest = event.data?.attributes?.test_mode === true;

  try {
    switch (name) {
      case 'order_created': {
        // Lemon Squeezy fires this when an order is successfully *placed* — for
        // a one-time license that is the payment event (the `*_payment_success`
        // names are subscription-only). Guarded on status so a created-but-not-
        // paid order (rare for Fast Links) is not fulfilled early.
        if (!isTest && event.data?.attributes?.status === 'paid') await fulfill(event);
        break;
      }
      case 'order_refunded': {
        const externalId = resolveRef(event);
        if (externalId) {
          const order = await getOrderByExternalId(externalId).catch(() => null);
          if (order) await setOrderStatus(order.id, 'refunded');
        }
        break;
      }
      default:
        break; // unknown event types are acknowledged, not errors
    }
  } catch (err) {
    // Non-2xx makes Lemon Squeezy retry — right behavior for a transient DB
    // outage; idempotency by reference id keeps a retried fulfillment safe.
    console.error(`[ls-webhook] ${name} failed`, err);
    return NextResponse.json({ error: 'processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
