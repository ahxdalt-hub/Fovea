/**
 * POST /api/webhooks/stripe — Stripe's only way in. This is the fulfillment
 * endpoint: on confirmed payment it marks the order paid and atomically hands
 * out one pre-issued license key from the pool (Supabase `claim_license_key`
 * RPC, schema.sql). It never mints a key — keys exist before the sale,
 * created offline by the vendor tool with a signing secret that lives nowhere
 * near this server.
 *
 * Request authenticity is enforced by Stripe's signature scheme: the raw body
 * is HMAC-SHA256'd together with the timestamp using FOVEA_STRIPE_WEBHOOK_SECRET
 * and compared against the `stripe-signature` header, with replay protection
 * via the timestamp window. A valid but unknown event type is acknowledged
 * with 200 (Stripe retries anything else forever).
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  claimLicenseKey,
  fulfillOrder,
  getOrderByExternalId,
  getOrdersByPaymentIntent,
  mergeOrderMetadata,
  setOrderStatus,
  supabaseConfigured,
  upsertOrder,
  type OrderRow,
  type OrderTier,
} from '@/lib/supabase';
import { TIER_EDITION } from '@/lib/commerce';

const REPLAY_WINDOW_SECONDS = 5 * 60;

function verifyStripeSignature(payload: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const [k, ...rest] = kv.split('=');
      return [k.trim(), rest.join('=').trim()];
    }),
  );
  const timestamp = parts['t'];
  const signatures = parts['v1'];
  if (!timestamp || !signatures) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_SECONDS) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest();
  return signatures
    .split(',')
    .map((sig) => Buffer.from(sig, 'hex'))
    .filter((buf) => buf.length === expected.length)
    .some((buf) => timingSafeEqual(buf, expected));
}

type StripeEvent = {
  type: string;
  data: { object: Record<string, unknown> };
};

function sessionTier(session: Record<string, unknown>): OrderTier | null {
  const metadata = session.metadata as { tier?: string } | null | undefined;
  const tier = metadata?.tier ?? session.client_reference_id;
  return tier === 'pro' || tier === 'studio' ? tier : null;
}

/**
 * Fulfill a paid checkout: ensure the order row exists, claim a key, mark it
 * fulfilled. Returns the order row (or null when the pool is dry / DB down),
 * so expired/completed handlers can share one code path.
 */
async function fulfill(session: Record<string, unknown>): Promise<OrderRow | null> {
  const externalId = typeof session.id === 'string' ? session.id : null;
  const tier = sessionTier(session);
  if (!externalId || !tier) {
    console.error('[webhook] paid session missing id/tier', session.id);
    return null;
  }

  const email = (session.customer_details as { email?: string } | null)?.email ?? null;
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : null;

  // DB errors are allowed to throw out of here: the POST handler turns them
  // into a 500, and Stripe retries with backoff — the right behavior for a
  // transient outage, versus 200-acknowledging a paid order into oblivion.
  let order = await getOrderByExternalId(externalId);
  if (order) {
    // The order may predate payment (recorded at checkout start); keep the
    // payment intent on it so refund events can find it later.
    if (paymentIntent) {
      await mergeOrderMetadata(order.id, { payment_intent: paymentIntent }).catch(() => {});
    }
  } else {
    order = await upsertOrder({
      provider: 'stripe',
      external_id: externalId,
      tier,
      edition: TIER_EDITION[tier]!,
      email,
      amount_total: typeof session.amount_total === 'number' ? session.amount_total : null,
      currency: typeof session.currency === 'string' ? session.currency : null,
      status: 'paid',
      metadata: paymentIntent ? { payment_intent: paymentIntent } : {},
    });
    if (!order) {
      console.error(`[webhook] ${externalId}: could not record the paid order`);
      return null;
    }
  }

  // null here means the pool is dry — a permanent condition, not an error:
  // the order stays 'paid' so the vendor sees it in Supabase and delivers a
  // key by hand. Never swallow a paid order.
  const license = await claimLicenseKey(TIER_EDITION[tier]!, order.id);
  if (!license) {
    console.error(`[webhook] ${externalId}: license pool empty for edition ${tier}`);
    return order;
  }

  await fulfillOrder(order.id, license);
  console.log(`[webhook] ${externalId}: fulfilled ${tier} order for ${email ?? 'unknown email'}`);
  return { ...order, status: 'fulfilled', license_key: license.key, license_id: license.licenseId };
}

export async function POST(req: NextRequest) {
  const secret = process.env.FOVEA_STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }

  // Authenticate before anything else: unsigned probes learn nothing about
  // the rest of the configuration.
  const payload = await req.text();
  const signature = req.headers.get('stripe-signature') ?? '';
  if (!verifyStripeSignature(payload, signature, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }
  if (!supabaseConfigured()) {
    return NextResponse.json({ error: 'database not configured' }, { status: 503 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  const session = event.data?.object ?? {};

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
          await fulfill(session);
        }
        break;
      }
      case 'checkout.session.expired': {
        const externalId = typeof session.id === 'string' ? session.id : null;
        if (externalId) {
          const order = await getOrderByExternalId(externalId).catch(() => null);
          if (order && order.status === 'pending') await setOrderStatus(order.id, 'canceled');
        }
        break;
      }
      case 'charge.refunded': {
        const pi = typeof session.payment_intent === 'string' ? session.payment_intent : null;
        if (pi) {
          const rows = await getOrdersByPaymentIntent(pi).catch(() => []);
          for (const order of rows) await setOrderStatus(order.id, 'refunded');
        }
        break;
      }
      default:
        break; // unknown event types are acknowledged, not errors
    }
  } catch (err) {
    // Non-2xx makes Stripe retry with backoff — right behavior for
    // transient DB failures.
    console.error(`[webhook] ${event.type} failed`, err);
    return NextResponse.json({ error: 'processing failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
