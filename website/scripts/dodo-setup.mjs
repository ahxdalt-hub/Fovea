#!/usr/bin/env node
/**
 * One command to make Dodo Payments sellable: it finds the Fovea brand, creates
 * the two one-time catalog products under that brand (if they are not there
 * yet), registers the fulfillment webhook, reads back the signing secret, and
 * prints the exact env lines to paste. Nothing here is a runtime dependency of
 * the website — it talks to Dodo with your API key and then exits.
 *
 *     cd website
 *     export FOVEA_DODO_API_KEY=liv..._or_test_key
 *     node scripts/dodo-setup.mjs                       # live mode, live site
 *     node scripts/dodo-setup.mjs --mode test           # sandbox catalog
 *     node scripts/dodo-setup.mjs --site http://localhost:3000   # local testing
 *
 * Re-running is safe and is the intended way to pick up the secret again: a
 * product tagged `fovea_tier` in its own metadata is reused rather than
 * duplicated, and an endpoint already registered on that URL is reused too.
 *
 * Brand discipline — read this before pointing it at a new account. One Dodo
 * business can hold several brands, and this account sells Caelmont/Veyra from
 * the same business as Fovea. Two consequences:
 *
 *   1. `POST /products` defaults `brand_id` to the business's primary brand.
 *      Omitting it would have created Fovea's products under Caelmont. So the
 *      brand is resolved by name first, passed explicitly on create, and
 *      verified on the way back; anything that does not come back tagged
 *      Fovea aborts the run.
 *   2. `POST /webhooks` has no brand parameter, so the endpoint also receives
 *      the other brand's events. The webhook route filters those; this script
 *      only registers the URL.
 *
 * Products are created in USD. Dodo's adaptive pricing may show the buyer a
 * different currency at checkout; the webhook records whatever was actually
 * charged, in the currency's smallest unit, which is the scale the `orders`
 * table already stores. Override the amounts with FOVEA_PRICE_PRO /
 * FOVEA_PRICE_STUDIO if the catalog should not use the shipped defaults.
 *
 * Test mode matters for the license pool: a test business is a separate
 * catalog on a different host, and the webhook ignores events from any other
 * business, so a sandbox payment can never consume a key signed for a real
 * buyer. Brands, however, share a business — see the route's cart check.
 */

const TIER_PRICES_USD = {
  pro: Number(process.env.FOVEA_PRICE_PRO ?? 49),
  studio: Number(process.env.FOVEA_PRICE_STUDIO ?? 129),
};
const WEBHOOK_EVENTS = [
  'payment.succeeded',
  'payment.failed',
  'payment.cancelled',
  'refund.succeeded',
];
const BRAND_NAME = 'fovea';

function parseArgs(argv) {
  const args = { mode: null, site: 'https://fovea.caelmont.in', base: null, brand: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--site') args.site = (argv[++i] ?? '').replace(/\/+$/, '');
    else if (argv[i] === '--base') args.base = argv[++i]?.replace(/\/+$/, '');
    else if (argv[i] === '--brand') args.brand = argv[++i];
    else {
      console.error(
        `Unknown argument: ${argv[i]}\nUsage: node scripts/dodo-setup.mjs [--mode test|live] [--site URL] [--brand brnd_…|--base URL]`,
      );
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const key = (process.env.FOVEA_DODO_API_KEY ?? '').trim();
if (!key) {
  console.error(
    'FOVEA_DODO_API_KEY must be set (the Dodo API key for the mode you are setting up).',
  );
  process.exit(1);
}
const mode = (args.mode ?? process.env.FOVEA_DODO_MODE ?? 'live').trim().toLowerCase();
if (mode !== 'test' && mode !== 'live') {
  console.error(`--mode must be 'test' or 'live', got '${mode}'.`);
  process.exit(1);
}
// --base is for pointing at a stand-in (a local mock of the API) when testing
// this script; the two Dodo hosts are the only real targets.
const BASE =
  args.base ??
  (mode === 'test' ? 'https://test.dodopayments.com' : 'https://live.dodopayments.com');

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Dodo ${init.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** Dodo's list endpoints page differently; take whichever array it returned. */
function items(body) {
  if (Array.isArray(body)) return body;
  return body?.data ?? body?.items ?? body?.records ?? [];
}

/** A webhook is identified by `webhook_id` on list and create; older shape used `id`. */
function webhookId(w) {
  return w?.webhook_id ?? w?.id;
}

/**
 * The brand Fovea sells under, resolved before any write. Refuses to run when
 * the account has no Fovea brand (products would land on the primary brand) and
 * refuses an explicit --brand that names a different one.
 */
async function resolveBrand() {
  const list = items(await api('/brands?page_size=100'));
  if (list.length === 0)
    throw new Error('Dodo returned no brands for this key — check the mode and the key.');

  const wanted = (args.brand ?? process.env.FOVEA_DODO_BRAND_ID ?? '').trim();
  const named = list.filter(
    (b) =>
      String(b?.name ?? '')
        .trim()
        .toLowerCase() === BRAND_NAME,
  );

  if (wanted) {
    const match = list.find((b) => (b?.brand_id ?? b?.id) === wanted);
    if (!match) {
      throw new Error(
        `Brand ${wanted} is not in this ${mode} account.\n` +
          `Available: ${list.map((b) => `${b?.brand_id ?? b?.id} (${b?.name})`).join(', ')}`,
      );
    }
    if (
      String(match?.name ?? '')
        .trim()
        .toLowerCase() !== BRAND_NAME
    ) {
      throw new Error(`Refusing to sell Fovea under brand "${match?.name}" (${wanted}).`);
    }
    return { brand: match, all: list };
  }

  if (named.length === 0) {
    throw new Error(
      `No brand named "Fovea" in this ${mode} account.\n` +
        `Available: ${list.map((b) => `${b?.brand_id ?? b?.id} (${b?.name})`).join(', ')}\n` +
        'Create the brand in the Dodo dashboard, or pass --brand brnd_… for the one you mean.',
    );
  }
  if (named.length > 1) {
    throw new Error(
      `More than one brand is named Fovea: ${named.map((b) => b?.brand_id ?? b?.id).join(', ')}. Pass --brand with the one to use.`,
    );
  }
  return { brand: named[0], all: list };
}

async function productForTier(tier, brandId) {
  const list = items(await api('/products?page_size=100&page_number=0'));
  const ours = list.filter((p) => p?.metadata?.fovea_tier === tier && !p?.archived);
  const foreign = ours.filter((p) => (p?.brand_id ?? brandId) !== brandId);
  if (foreign.length > 0) {
    // A fovea_tier-tagged product living under another brand is a catalog
    // mistake, and the cheapest thing to fix is here, not in a buyer's receipt.
    throw new Error(
      `Product ${foreign[0].product_id} is tagged fovea_tier=${tier} but belongs to brand ` +
        `${foreign[0].brand_id}, not ${brandId}. Archive or retag it in the Dodo dashboard; this script will not move it.`,
    );
  }

  const existing = ours[0];
  if (existing) {
    console.log(`· ${tier}: reusing product ${existing.product_id} (${existing.name})`);
    return existing;
  }

  const cents = Math.round(TIER_PRICES_USD[tier] * 100);
  const created = await api('/products', {
    method: 'POST',
    body: JSON.stringify({
      name: `Fovea ${tier === 'pro' ? 'Pro' : 'Studio'} (one-time)`,
      description:
        tier === 'pro'
          ? 'Fovea Pro — 4x enhancement, Natural and Detail modes, unlimited monthly enhancements. One-time, per machine, offline activation.'
          : 'Fovea Studio — everything in Pro plus engine controls and five machine keys. One-time, offline activation.',
      // Without this, Dodo files the product under the business's primary
      // brand, which here is Caelmont.
      brand_id: brandId,
      tax_category: 'digital_products',
      price: { type: 'one_time_price', currency: 'USD', price: cents },
      metadata: { app: 'fovea', fovea_tier: tier },
    }),
  });
  if (created?.brand_id && created.brand_id !== brandId) {
    throw new Error(
      `Created ${created.product_id} but Dodo filed it under brand ${created.brand_id}, not ${brandId}. ` +
        'Archive it in the dashboard before rerunning.',
    );
  }
  console.log(
    `· ${tier}: created product ${created.product_id} at $${TIER_PRICES_USD[tier]} under brand ${brandId}`,
  );
  return created;
}

async function webhookEndpoint(url) {
  const list = items(await api('/webhooks'));
  const existing = list.find((w) => w?.url === url);
  if (existing) {
    console.log(`· webhook: endpoint ${webhookId(existing)} already points at ${url}`);
    return existing;
  }
  const created = await api('/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      url,
      description: 'Fovea — license fulfillment',
      filter_types: WEBHOOK_EVENTS,
    }),
  });
  console.log(`· webhook: created endpoint ${webhookId(created)} for ${url}`);
  return created;
}

try {
  console.log(`Dodo ${mode} mode (${BASE})`);
  const { brand, all: brands } = await resolveBrand();
  const brandId = brand?.brand_id ?? brand?.id;
  console.log(`· brand: ${brand?.name} = ${brandId}`);

  const otherBrands = brands.filter((b) => (b?.brand_id ?? b?.id) !== brandId);
  if (otherBrands.length > 0) {
    console.log(
      `· note: this business also holds ${otherBrands.map((b) => `"${b?.name}"`).join(', ')} — ` +
        'their products and payments are left alone, and their webhook events arrive at the same endpoint.',
    );
  }

  const pro = await productForTier('pro', brandId);
  const studio = await productForTier('studio', brandId);
  const url = `${args.site}/api/webhooks/dodo`;
  const hook = await webhookEndpoint(url);
  const id = webhookId(hook);
  if (!id)
    throw new Error(`Webhook came back without an id: ${JSON.stringify(hook).slice(0, 200)}`);
  const secretBody = await api(`/webhooks/${id}/secret`);
  const secret = secretBody?.secret;
  if (!secret)
    throw new Error(`No secret returned for webhook ${id}: ${JSON.stringify(secretBody)}`);

  const businessId = brand?.business_id ?? pro.business_id ?? studio.business_id;
  if (!businessId) throw new Error('Dodo did not return a business_id on the brand or products.');

  const foreignProducts = items(await api('/products?page_size=100')).filter(
    (p) => p?.metadata?.app !== 'fovea' && !p?.archived,
  );
  if (foreignProducts.length > 0) {
    console.log(
      `· untouched: ${foreignProducts.map((p) => `${p.product_id} ("${p.name}")`).join(', ')} — not Fovea's catalog.`,
    );
  }

  console.log('\nPaste these into website/.env.local (dev) and set them on the Worker:');
  console.log(
    [
      'FOVEA_PAYMENT_PROVIDER=dodo',
      `FOVEA_DODO_MODE=${mode}`,
      `FOVEA_DODO_BUSINESS_ID=${businessId}`,
      `FOVEA_DODO_BRAND_ID=${brandId}`,
      `FOVEA_DODO_PRODUCT_PRO=${pro.product_id}`,
      `FOVEA_DODO_PRODUCT_STUDIO=${studio.product_id}`,
      `FOVEA_DODO_WEBHOOK_SECRET=${secret}`,
      `FOVEA_DODO_API_KEY=${key}`,
    ].join('\n'),
  );

  if (mode === 'live') {
    console.log(
      '\nOn Cloudflare (from website/): the two secret values go through\n' +
        '  wrangler secret put FOVEA_DODO_API_KEY\n' +
        '  wrangler secret put FOVEA_DODO_WEBHOOK_SECRET\n' +
        'and FOVEA_DODO_BUSINESS_ID / _BRAND_ID / _PRODUCT_PRO / _PRODUCT_STUDIO /\n' +
        'FOVEA_PAYMENT_PROVIDER go in wrangler.jsonc vars (identifiers, not credentials).',
    );
  }
  console.log(
    `\nCheckout URL for the hosted page: ${args.site}/api/checkout?tier=pro\n` +
      'Fulfillment needs the Supabase license pool filled (see BACKEND.md step 3), or a paid\n' +
      'order records as paid-with-no-key and gets a key delivered by hand.',
  );
} catch (err) {
  console.error(`\n${err.message}`);
  console.error(
    '\nNothing was changed if this failed on the first call. A partial run is safe to retry:\n' +
      'products and endpoints already created are reused, not duplicated.',
  );
  process.exit(1);
}
