# Fovea website — Supabase backend & payments

How the site's server backend works, and the exact steps to take it live.
The design keeps two promises made in `lib/commerce.ts`: the website never
touches image data, and it never holds (or mints) a license signing secret.

## Architecture

```
Buyer                    Website (Cloudflare Worker)            Supabase                Vendor
  │  Buy Pro  ──────────►  /api/checkout                        │                       │
  │                        └─ Stripe Checkout Session created   │                       │
  │                          └─ 'pending' order row ──────────► orders                  │
  │  ◄─ redirect to Stripe-hosted payment page ──┘              │                       │
  │  pay                                                        │                       │
  │        Stripe ── checkout.session.completed ─────►  /api/webhooks/stripe            │
  │                        ├─ verify HMAC signature             │                       │
  │                        ├─ order → 'paid'                    └─ claim_license_key RPC│
  │                        └─ claim one pre-issued key ─────────► license_pool           │
  │  ◄─ /download?…&session_id=…  shows the claimed key                                │
  │                                                                                    │
  └── keys got into the pool BEFORE the sale: cargo run --example issue_license ───────┘
      (Ed25519 signing seed never leaves the vendor machine)
```

Why pre-issued keys? The desktop app verifies licenses **offline** against an
embedded Ed25519 public key (`src-tauri/src/services/license/`). Minting a key
requires the private seed, which must never exist on a web server. So the
vendor mints a batch ahead of time; Supabase hands out exactly one per paid
order (atomic `FOR UPDATE SKIP LOCKED` — two concurrent payments can never
share a key).

## Database (`supabase/schema.sql`)

| Table / function | Purpose |
| --- | --- |
| `orders` | One row per checkout: tier, edition, email, amount, status (`pending → paid → fulfilled`, or `canceled` / `refunded`), Stripe session id, claimed license key. |
| `license_pool` | Pre-issued keys waiting to be sold, each claimed at most once. |
| `claim_license_key(edition, order_id)` | Atomic key handout used by the webhook. |
| `merge_order_metadata(id, patch)` | Records the Stripe `payment_intent` on the order so refund events can find it. |

Row Level Security is enabled on both tables with **zero policies** (deny all
to `anon`/`authenticated`); the site's server uses the `service_role` key,
which bypasses RLS. Nothing here is called from the browser.

## Setup — five steps

1. **Create the schema** — Supabase dashboard → SQL Editor → paste
   `website/supabase/schema.sql` → Run.
2. **Service role key** — dashboard → Project Settings → API keys → copy the
   `service_role` key into:
   - local dev: `website/.env.local` → `SUPABASE_SERVICE_ROLE_KEY`
   - production: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (in `website/`)
3. **Fill the license pool** — mint keys offline and import them:
   ```bash
   cargo run --release --example issue_license -- --dev \
     --holder "orders@caelmont.in" --edition pro --id PL-2026-000001
   # …collect the printed FOVEA1.… keys into keys-pro.txt (one per line), then:
   cd website && node --env-file=.env.local scripts/import-license-keys.mjs --file keys-pro.txt
   ```
   Edition and license id are read from the signed payload itself, so a
   mislabeled file is rejected rather than trusted. Re-running is safe
   (duplicates are skipped).
4. **Connect Stripe** — create API key + webhook:
   - `FOVEA_STRIPE_SECRET_KEY` → `.env.local` / `wrangler secret put`
   - Prices: set `FOVEA_STRIPE_PRICE_PRO` / `_STUDIO` to pre-created Price ids,
     or leave them unset and the adapter creates prices inline from
     `FOVEA_STRIPE_AMOUNT_PRO_USD` (49) / `FOVEA_STRIPE_AMOUNT_STUDIO_USD` (129).
   - Webhook endpoint: `https://fovea.caelmont.in/api/webhooks/stripe`
     (local: run `stripe listen --forward-to localhost:3000/api/webhooks/stripe`),
     subscribed to `checkout.session.completed`, `checkout.session.expired`,
     `charge.refunded`. Copy the signing secret to `FOVEA_STRIPE_WEBHOOK_SECRET`.
   - Flip `FOVEA_PAYMENT_PROVIDER=stripe` (`.env.local` / `wrangler.jsonc` vars).
5. **Verify** — buy the Pro tier with Stripe's test card `4242 4242 4242 4242`;
   you should land on `/download` with a real claimed key shown, and the order
   in Supabase should read `fulfilled`.

## Degradation behavior (by design)

| Missing piece | What happens |
| --- | --- |
| `SUPABASE_*` not set | Checkout and delivery work exactly like the old manual flow; no orders are recorded, `/download` shows the generic "delivered by your purchase channel" text. |
| `FOVEA_STRIPE_SECRET_KEY` missing while provider is `stripe` | `/api/checkout` returns **503** — it never silently downgrades to the free manual path, which would sell a license nobody delivers. |
| License pool runs dry | Payment is confirmed, order stays `pending`→`paid` with no key; the vendor sees it in the Supabase dashboard and delivers manually. Never a lost sale. |
| Webhook secret missing | `/api/webhooks/stripe` returns 503; Stripe retries. |

## Security notes

- `service_role`, Stripe secret and webhook secret are server-side only and
  read from env at call time (never `NEXT_PUBLIC_*`, never shipped to the browser).
- The webhook verifies Stripe's HMAC signature with a 5-minute replay window
  before touching the database.
- `/download?session_id=…` uses the Stripe Checkout Session id (long random
  string) as the lookup token for a claimed key — the same token Stripe hands
  only to the buyer. Keys are additionally sent by the purchase receipt; keep
  treating the confirmation email as the durable copy.
- The license signing seed exists only on the vendor machine (`issue_license.rs`).
