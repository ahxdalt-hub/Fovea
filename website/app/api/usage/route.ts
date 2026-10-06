/**
 * /api/usage — the free plan's 10-images-a-month allowance, counted on the
 * server instead of on the user's machine.
 *
 *   GET  /api/usage?install_id=…            read the balance, spend nothing
 *   POST /api/usage  {"install_id":"…","count":1}   spend, return the balance after
 *
 * Why this exists at all: src-tauri/src/services/quota.rs keeps a *cache* of
 * what this route last said, and the desktop app's own calendar month came
 * from the Windows clock — which is editable, and deleting one file reset the
 * meter. Here the calendar month comes from the database's `now()`, and the
 * allowance comes from `free_monthly_limit()` — a request that carries no
 * limit cannot raise one.
 *
 * Two meters move per call: the install (`install_id`, ceiling 10) and a salted
 * hash of the requester's address (ceiling 30, `free_ip_monthly_limit()`).
 * The second one is what makes the first worth having. `install_id` is a string
 * the client chooses, so minting a new one would mint a fresh allowance —
 * unless every id from one network shares a ceiling. A home or office NAT
 * legitimately holds several machines, which is why that ceiling is 30 rather
 * than 10: it is a spam brake, not a device census.
 *
 * No auth, no signature, deliberately. A free desktop app cannot hold a secret
 * — anything compiled into the binary is extractable by exactly the person this
 * defends against. What the pair of meters buys is not unbreakable, it is
 * boring to break: rotate install ids and you hit the network ceiling; spoof
 * the network and you are paying for addresses or rewriting a registry value.
 *
 * Privacy: the address is hashed with FOVEA_USAGE_IP_SALT and never stored —
 * the row is 43 hex characters, not an address. The salt must not be rotated:
 * a new salt renames every network bucket and refills them mid-month.
 *
 * The desktop app never reaches Supabase; this route is the only door, and it
 * talks as service_role.
 */

import { NextRequest, NextResponse } from 'next/server';
import { peekCredits, spendCredits, supabaseConfigured, type CreditSnapshot } from '@/lib/supabase';

/** Same shape the database checks, so a bad id is a 400 rather than a 500. */
const METER_ID = /^[a-z0-9]{8,64}$/;
/** A batch queue is capped well below this in the app; this is the abuse ceiling. */
const MAX_COUNT = 1000;

const NO_STORE = { 'Cache-Control': 'no-store' };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The install id the app was given, or null for anything else. */
function installId(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  return METER_ID.test(id) ? id : null;
}

/** The address as Cloudflare saw it. Empty when the app is not behind them. */
function clientIp(req: NextRequest): string {
  const direct = req.headers.get('cf-connecting-ip');
  if (direct) return direct.trim();
  const chain = req.headers.get('x-forwarded-for');
  return chain ? (chain.split(',')[0] ?? '').trim() : '';
}

/**
 * `iph` + a truncated digest, so it passes the meter id pattern and the
 * database routes it to the network allowance. 160 bits is more than enough
 * collision resistance for counting free images.
 */
async function ipMeter(address: string, salt: string): Promise<string | null> {
  if (!address || !salt) return null;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${salt}|${address}`),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `iph${hex.slice(0, 40)}`;
}

/**
 * One response for both verbs. `allowed` is the verdict the app acts on: the
 * install has credit AND the network has not been drained. A missing salt
 * leaves the network meter out rather than refusing service — the per-install
 * count is still server-authoritative, which is the part that was broken.
 */
function respond(install: CreditSnapshot, network: CreditSnapshot | null) {
  const allowed = install.remaining > 0 && (network === null || network.remaining > 0);
  return json({
    period: install.period,
    used: install.used,
    remaining: install.remaining,
    limit: install.limit,
    allowed,
    // The app's own clock is suspect by design; this is the time to believe.
    server_time: Math.floor(Date.now() / 1000),
    network_used: network?.used ?? null,
    network_remaining: network?.remaining ?? null,
  });
}

export async function GET(req: NextRequest) {
  if (!supabaseConfigured()) {
    return json({ error: 'usage meter not configured' }, 503);
  }
  const id = installId(req.nextUrl.searchParams.get('install_id'));
  if (!id) return json({ error: 'unknown install id' }, 400);

  try {
    const install = await peekCredits(id);
    if (!install) return json({ error: 'meter unread' }, 503);
    const network = await peekNetwork(req);
    return respond(install, network);
  } catch (err) {
    console.error('[usage] read failed:', err);
    return json({ error: 'usage read failed' }, 500);
  }
}

export async function POST(req: NextRequest) {
  if (!supabaseConfigured()) {
    return json({ error: 'usage meter not configured' }, 503);
  }

  // Small body, fixed shape. The text is capped before parsing so a flood of
  // bytes cannot make this route allocate on someone else's dime.
  const text = await req.text().catch(() => '');
  if (text.length === 0 || text.length > 2048) return json({ error: 'invalid body' }, 400);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const raw = (body ?? {}) as { install_id?: unknown; count?: unknown };
  const id = installId(typeof raw.install_id === 'string' ? raw.install_id : null);
  const count = typeof raw.count === 'number' ? Math.trunc(raw.count) : NaN;
  if (!id) return json({ error: 'unknown install id' }, 400);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return json({ error: `count must be an integer from 1 to ${MAX_COUNT}` }, 400);
  }

  try {
    const install = await spendCredits(id, count);
    if (!install) return json({ error: 'meter unwritten' }, 503);

    // Charged after the install, so the install balance the app sees is the one
    // it just moved. A network meter cannot be raised by a client, whichever
    // order the writes happen in.
    const network = await spendNetwork(req, count);
    return respond(install, network);
  } catch (err) {
    // Non-2xx matters: the app keeps its cached balance and can retry, rather
    // than treating a database outage as "you are out of free images".
    console.error('[usage] spend failed:', err);
    return json({ error: 'usage spend failed' }, 500);
  }
}

/** The network meter for this request, or null when it cannot be computed. */
async function networkMeter(req: NextRequest): Promise<string | null> {
  const salt = process.env.FOVEA_USAGE_IP_SALT?.trim();
  if (!salt) {
    console.warn('[usage] FOVEA_USAGE_IP_SALT unset — install ids rotate freely');
    return null;
  }
  return ipMeter(clientIp(req), salt);
}

async function peekNetwork(req: NextRequest): Promise<CreditSnapshot | null> {
  const meter = await networkMeter(req);
  return meter ? peekCredits(meter) : null;
}

async function spendNetwork(req: NextRequest, count: number): Promise<CreditSnapshot | null> {
  const meter = await networkMeter(req);
  return meter ? spendCredits(meter, count) : null;
}
