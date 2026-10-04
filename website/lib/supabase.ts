/**
 * Server-side Supabase access — a thin, typed REST client over PostgREST.
 *
 * Deliberately no @supabase/supabase-js dependency: the website only performs
 * a handful of server-side CRUD calls (order records, license claims), all
 * with the service_role key, and raw fetch keeps the deploy (Cloudflare
 * Workers via OpenNext) dependency-free and fully controllable.
 *
 * Safety properties:
 *   * Every call here happens server-side only. The service_role key is read
 *     from env at call time and never leaves the server — nothing in this
 *     file is importable by client components.
 *   * All callers tolerate "Supabase not configured" (checkout and delivery
 *     still work; fulfillment just can't be automated until it is).
 *   * RLS denies everything to anon/authenticated; these calls bypass RLS
 *     because they run as service_role.
 */

const BASE_URL = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

export type OrderTier = 'pro' | 'studio';
export type OrderEdition = 'pro' | 'studio';
export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'canceled' | 'refunded';

export type OrderRow = {
  id: string;
  created_at: string;
  updated_at: string;
  provider: string;
  external_id: string | null;
  tier: OrderTier;
  edition: OrderEdition;
  email: string | null;
  amount_total: number | null;
  currency: string | null;
  status: OrderStatus;
  license_key: string | null;
  license_id: string | null;
  metadata: Record<string, unknown>;
};

/** True when the server has the env it needs to reach Supabase. */
export function supabaseConfigured(): boolean {
  return BASE_URL.length > 0 && SERVICE_KEY.length > 0;
}

class SupabaseError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function sb<T>(path: string, init: RequestInit & { prefer?: string } = {}): Promise<T> {
  if (!supabaseConfigured()) {
    throw new SupabaseError(503, 'Supabase is not configured');
  }
  const headers: Record<string, string> = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    ...(init.prefer ? { Prefer: init.prefer } : {}),
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers, cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SupabaseError(res.status, `Supabase ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return (text.length > 0 ? JSON.parse(text) : null) as T;
}

/** Insert an order (or update it in place when external_id already exists). */
export async function upsertOrder(
  order: Pick<OrderRow, 'provider' | 'external_id' | 'tier' | 'edition'> &
    Partial<Pick<OrderRow, 'email' | 'amount_total' | 'currency' | 'status' | 'metadata'>>,
): Promise<OrderRow | null> {
  const rows = await sb<OrderRow[]>('/rest/v1/orders?on_conflict=external_id', {
    method: 'POST',
    body: JSON.stringify({ status: 'pending', metadata: {}, ...order }),
    prefer: 'resolution=merge-duplicates,return=representation',
  });
  return rows[0] ?? null;
}

/** Look up an order by its provider-side id (Stripe Checkout Session id). */
export async function getOrderByExternalId(externalId: string): Promise<OrderRow | null> {
  const rows = await sb<OrderRow[]>(
    `/rest/v1/orders?external_id=eq.${encodeURIComponent(externalId)}&limit=1`,
  );
  return rows[0] ?? null;
}

/** Transition an order's status (guarded: never move a fulfilled order backwards). */
export async function setOrderStatus(id: string, status: OrderStatus): Promise<void> {
  await sb(`/rest/v1/orders?id=eq.${id}&status=neq.fulfilled`, {
    method: 'PATCH',
    body: JSON.stringify({ status, updated_at: new Date().toISOString() }),
    prefer: 'return=minimal',
  });
}

/** Merge fields into an order's metadata JSON (for payment_intent, etc.). */
export async function mergeOrderMetadata(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await sb('/rest/v1/rpc/merge_order_metadata', {
    method: 'POST',
    body: JSON.stringify({ p_id: id, p_patch: patch }),
  });
}

/** Orders whose metadata carries a given Stripe payment_intent (refund handling). */
export async function getOrdersByPaymentIntent(paymentIntent: string): Promise<OrderRow[]> {
  return sb<OrderRow[]>(
    `/rest/v1/orders?metadata->>payment_intent=eq.${encodeURIComponent(paymentIntent)}`,
  );
}

/**
 * Atomically claim one unclaimed license key of the given edition for an
 * order. Runs the `claim_license_key` SECURITY DEFINER RPC (schema.sql), so
 * two concurrent payments can never receive the same key. Returns null when
 * the pool is dry — the caller keeps the order 'paid' so a human can deliver.
 */
export async function claimLicenseKey(
  edition: OrderEdition,
  orderId: string,
): Promise<{ key: string; licenseId: string } | null> {
  const rows = await sb<{ claimed_key: string; claimed_license_id: string }[]>(
    '/rest/v1/rpc/claim_license_key',
    {
      method: 'POST',
      body: JSON.stringify({ p_edition: edition, p_order_id: orderId }),
    },
  );
  const row = rows?.[0];
  if (!row || !row.claimed_key) return null;
  return { key: row.claimed_key, licenseId: row.claimed_license_id };
}

/** Mark an order fulfilled with its delivered key. */
export async function fulfillOrder(
  id: string,
  license: { key: string; licenseId: string },
): Promise<void> {
  await sb(`/rest/v1/orders?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'fulfilled',
      license_key: license.key,
      license_id: license.licenseId,
      updated_at: new Date().toISOString(),
    }),
    prefer: 'return=minimal',
  });
}
