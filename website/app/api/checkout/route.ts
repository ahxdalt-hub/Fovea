import { NextRequest, NextResponse } from 'next/server';
import { resolveProvider, type TierId } from '@/lib/commerce';
import { ProviderConfigError } from '@/lib/providers/stripe';

const ALLOWED: readonly string[] = ['pro', 'studio', 'evaluate'];

function reject(tier: unknown): NextResponse | null {
  if (typeof tier !== 'string' || !ALLOWED.includes(tier)) {
    return NextResponse.json({ error: 'unknown tier' }, { status: 400 });
  }
  return null;
}

async function begin(tier: TierId, origin: string): Promise<NextResponse> {
  let result;
  try {
    result = await resolveProvider().startCheckout({ tier, successUrl: origin });
  } catch (err) {
    // A misconfigured processor must fail loudly, never silently downgrade to
    // the free manual path (which would sell a license nobody delivers).
    const status = err instanceof ProviderConfigError ? 503 : 502;
    console.error(`[checkout] ${tier}:`, err);
    return NextResponse.json(
      { error: 'checkout unavailable', detail: err instanceof Error ? err.message : String(err) },
      { status },
    );
  }
  const target =
    result.kind === 'redirect' ? result.url : new URL(result.redirectTo, origin).toString();
  return NextResponse.redirect(target, 303);
}

/**
 * GET /api/checkout?tier=… — the JS-free entry the pricing buttons use. Starts
 * a checkout through the configured, isolated PaymentProvider and redirects.
 * It does not mint a license, hold a signing secret, or see an image.
 */
export async function GET(req: NextRequest) {
  const bad = reject(req.nextUrl.searchParams.get('tier'));
  if (bad) return bad;
  return begin(req.nextUrl.searchParams.get('tier') as TierId, req.nextUrl.origin);
}

/**
 * POST /api/checkout — the form/json equivalent of the GET above, for when a
 * real provider needs a request body. Same isolation guarantees.
 */
export async function POST(req: NextRequest) {
  let tier: unknown;
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    tier = (await req.json().catch(() => ({})))?.tier;
  } else {
    const form = await req.formData().catch(() => null);
    tier = form?.get('tier');
  }
  const bad = reject(tier);
  if (bad) return bad;
  return begin(tier as TierId, req.nextUrl.origin);
}
