# Fovea website — Supabase backend & payments

How the site's server backend works, and the exact steps to take it live.
The design keeps two promises made in `lib/commerce.ts`: the website never
touches image data, and it never holds (or mints) a license signing secret.

**Dodo Payments is the processor the site sells through** (`FOVEA_PAYMENT_PROVIDER=dodo`).
They are the merchant of record: hosted checkout card/PayPal/local methods,
sales tax and VAT, chargebacks and payouts are theirs. Stripe and Lemon Squeezy
adapters stay wired, and `manual` is the secret-free fallback for a fresh clone.

## Architecture

```
Buyer                    Website (Cloudflare Worker)            Supabase                Vendor
  │  Buy Pro  ──────────►  /api/checkout                        │                       │
  │                        └─ Dodo Checkout Session created     │                       │
  │                          (random `ref` in its metadata)     │                       │
  │                          └─ 'pending' order row ──────────► orders                  │
  │  ◄─ redirect to Dodo-hosted payment page ──┘                │                       │
  │  pay                                                        │                       │
  │        Dodo ── payment.succeeded ──────────────────►  /api/webhooks/dodo            │
  │                        ├─ verify Standard-Webhooks signature│                       │
  │                        ├─ check business_id (live vs test)  └─ claim_license_key RPC│
  │                        ├─ order → 'paid'                    │                       │
  │                        └─ claim one pre-issued key ─────────► license_pool          │
  │  ◄─ /download?…&ref=…  shows the claimed key                                        │
  │                                                                                    │
  └── keys got into the pool BEFORE the sale: cargo run --example issue_license ────────┘
      (Ed25519 signing seed never leaves the vendor machine)
```

Why pre-issued keys? The desktop app verifies licenses **offline** against an
embedded Ed25519 public key (`src-tauri/src/services/license/`). Minting a key
requires the private seed, which must never exist on a web server. So the
vendor mints a batch ahead of time; Supabase hands out exactly one per paid
order (atomic `FOR UPDATE SKIP LOCKED` — two concurrent payments can never
share a key).

Why a `ref` we mint ourselves? Dodo's payment ids and the buyer's redirect URL
both work as lookup tokens, but a random id created before the payment exists is
what ties the pending row to the fulfilled one, it is unguessable, and it is the
same value `/download` reads. It rides through checkout as session `metadata`
and comes back in the webhook.

### The free plan's counter

The desktop app makes one kind of network call, and only on the free plan:
`src-tauri/src/services/quota.rs` asks `/api/usage` for the month's balance at
launch (GET) and reports finished images afterwards (POST). The answer is cached
in `quota.json`, so enhancing keeps working offline on the last balance the
server confirmed — and an install that has never reached the server has no
balance to spend, which the UI says out loud instead of showing `10 of 10`.

Two counters move per call: the install id (10 a month) and a salted hash of the
requester's address (30 a month). The second one is what makes the first worth
having — an install id is a string the client chooses, so without a network
ceiling, minting a new id would mint a new allowance. The month is the database's
`now()`, never the Windows clock. Paid plans make no call at all.

## Database (`supabase/schema.sql`)

| Table / function                                            | Purpose                                                                                                                                                                     |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orders`                                                    | One row per checkout: tier, edition, email, amount (smallest currency unit), status (`pending → paid → fulfilled`, or `canceled` / `refunded`), `ref`, claimed license key. |
| `license_pool`                                              | Pre-issued keys waiting to be sold, each claimed at most once.                                                                                                              |
| `claim_license_key(edition, order_id)`                      | Atomic key handout used by the webhook.                                                                                                                                     |
| `merge_order_metadata(id, patch)`                           | Records the Dodo `payment_id` on the order so refund events can find it.                                                                                                    |
| `free_usage`                                                | The free plan's counter: one row per meter per month. `install_id` holds either the app's machine fingerprint or a salted `iph…` address hash — never an address.           |
| `free_monthly_limit()` / `free_ip_monthly_limit()`          | The allowances (10 per install, 30 per network). A request cannot raise one; changing the plan is one SQL edit, no deploy.                                                  |
| `spend_credits(meter_id, count)` / `peek_credits(meter_id)` | What `/api/usage` calls. Spend is atomic and refuses whole, so a batch never partly drains a month.                                                                         |
| `limit_for_meter(meter_id)`                                 | Which allowance a meter id gets — the network bucket or the install's own.                                                                                                  |

Row Level Security is enabled on all three tables with **zero policies** (deny all
to `anon`/`authenticated`); the site's server uses the `service_role` key,
which bypasses RLS. Nothing here is called from the browser.

## Setup — six steps

1. **Create the schema** — Supabase dashboard → SQL Editor → paste
   `website/supabase/schema.sql` → Run. It is idempotent, and it creates the
   free plan's `free_usage` counter alongside the order and key tables.
   Verified against a real Postgres 18 on 2026-10-06: it applies twice in a row,
   the month rollover and both ceilings behave, 3 concurrent claims hand out 3
   distinct keys, and `anon` is locked out of every table. An empty pool returns
   a NULL row from `claim_license_key` rather than no row, which the webhook
   already treats as "nothing to deliver".
2. **Service role key** — dashboard → Project Settings → API keys → copy the
   `service_role` key into:
   - local dev: `website/.env.local` → `SUPABASE_SERVICE_ROLE_KEY`
   - production: `wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (in `website/`)
3. **The meter salt** — the free plan's network counter is keyed by a salt so no
   address is ever stored. Generate one and keep it forever:
   ```bash
   node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
   ```
   Paste it into `website/.env.local` as `FOVEA_USAGE_IP_SALT=…` and onto the
   Worker with `wrangler secret put FOVEA_USAGE_IP_SALT`. **Never rotate it** — a
   new salt renames every network bucket and refills each one mid-month. With the
   salt unset the meter still works; it just skips the network ceiling, which is
   the one thing that stops a fleet of fresh install ids.
4. **Fill the license pool** — mint keys offline and import them:
   ```bash
   cargo run --release --manifest-path ../src-tauri/Cargo.toml \
     --example issue_license -- --holder "orders@caelmont.in" --edition pro --id PL-2026-000001
   # …collect the printed FOVEA1.… keys into keys-pro.txt (one per line), then:
   cd website && node --env-file=.env.local scripts/import-license-keys.mjs --file keys-pro.txt
   ```
   Edition and license id are read from the signed payload itself, so a
   mislabeled file is rejected rather than trusted. Re-running is safe
   (duplicates are skipped). Keys signed with the committed `--dev` pair are
   rejected on import: a released build cannot verify them.

   The launch pool is already minted — 25 Pro and 25 Studio perpetual, unbound
   keys, each one checked against the release build's verifier — in
   `~/fovea-vendor/pool/keys-pro.txt` and `keys-studio.txt`. That directory is
   outside the repo on purpose: a keys file is inventory, never a commit. After
   step 1, both files import with:
   ```bash
   cd website
   export FOVEA_LICENSE_PUBKEYS=$(cat ~/fovea-vendor/fovea-license-public.hex)
   node --env-file=.env.local scripts/import-license-keys.mjs --file ~/fovea-vendor/pool/keys-pro.txt
   node --env-file=.env.local scripts/import-license-keys.mjs --file ~/fovea-vendor/pool/keys-studio.txt
   ```
5. **Connect Dodo** — one command does the catalog and the endpoint:
   ```bash
   cd website
   export FOVEA_DODO_API_KEY=live_…            # dashboard → Developers → API keys
   node scripts/dodo-setup.mjs
   ```
   It creates the Pro ($49) and Studio ($129) one-time products if they do not
   exist, registers `https://fovea.caelmont.in/api/webhooks/dodo` for
   `payment.succeeded`, `payment.failed`, `payment.cancelled` and
   `refund.succeeded`, reads back the signing secret, and prints the whole env
   block. Paste it into `website/.env.local`, and put the three secret values on
   the Worker with `wrangler secret put FOVEA_DODO_API_KEY` /
   `wrangler secret put FOVEA_DODO_WEBHOOK_SECRET`; the ids
   (`FOVEA_DODO_BUSINESS_ID`, `FOVEA_DODO_PRODUCT_PRO`, `FOVEA_DODO_PRODUCT_STUDIO`)
   go in `wrangler.jsonc` vars. Re-running the script is safe — it reuses what
   it already created.
   Test first with a sandbox: `node scripts/dodo-setup.mjs --mode test --site http://localhost:3000`,
   run the site with `FOVEA_DODO_MODE=test` and `FOVEA_PAYMENT_PROVIDER=dodo`, then
   pay with a Dodo test card. Set `FOVEA_DODO_BUSINESS_ID` to the **live**
   business id in production so a test payment is ignored rather than draining a
   real key.
6. **Verify** — buy the Pro tier end to end; you should land on `/download` with
   a real claimed key shown, and the order in Supabase should read `fulfilled`
   with the Dodo `payment_id` in its metadata. Then check the meter from the same
   terminal — a GET spends nothing, so it is safe to poke:
   ```bash
   curl -s "https://fovea.caelmont.in/api/usage?install_id=smoketest00000000000000000000"
   # {"period":"2026-10","used":0,"remaining":10,"limit":10,"allowed":true,…}
   ```
   `allowed: false` with `network_remaining: 0` means this machine's network
   bucket is drained, not that the install is out of images. A 503 means
   `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are missing on the Worker; a 404
   means the deployed Worker predates the `/api/usage` route and needs a
   redeploy. For the desktop app against a local meter, run `npm run dev` in
   `website/` and start the app with
   `FOVEA_METER_URL=http://localhost:3000/api/usage` (plain http is accepted for
   loopback only) — the free plan then counts against your own database.

## Degradation behavior (by design)

| Missing piece                                                         | What happens                                                                                                                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_*` not set                                                  | Checkout and delivery work exactly like the old manual flow; no orders are recorded, `/download` shows the generic "delivered by your purchase channel" text.                             |
| `FOVEA_DODO_API_KEY` or a product id missing while provider is `dodo` | `/api/checkout` returns **503** — it never silently downgrades to the free manual path, which would sell a license nobody delivers.                                                       |
| `FOVEA_DODO_WEBHOOK_SECRET` missing                                   | `/api/webhooks/dodo` returns 503; Dodo retries the delivery.                                                                                                                              |
| `FOVEA_DODO_BUSINESS_ID` missing                                      | The webhook accepts events from any business that carries a valid signature for your endpoint — including a test business. Set it in production.                                          |
| `FOVEA_USAGE_IP_SALT` missing                                         | `/api/usage` counts installs only; the network ceiling is skipped and the app logs nothing. A rotating install id can then refarm 10 a month, so set it before advertising the free plan. |
| `/api/usage` unreachable                                              | The app keeps the last balance the server confirmed and spends it offline. An install that has _never_ reached it cannot count at all, and says so.                                       |
| License pool runs dry                                                 | Payment is confirmed, order stays `paid` with no key; the vendor sees it in the Supabase dashboard and delivers manually. Never a lost sale.                                              |

## Security notes

- `service_role`, the Dodo API key and the webhook secret are server-side only
  and read from env at call time (never `NEXT_PUBLIC_*`, never shipped to the browser).
- The webhook authenticates the **raw** body before parsing it: Dodo follows the
  Standard Webhooks scheme — HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}`,
  keyed with the base64-decoded `whsec_…` secret, compared constant-time against
  the `v1,<base64>` entries of `webhook-signature`, with a five-minute timestamp
  window. `webhook-id` doubles as the dedupe key, and fulfillment is idempotent
  by `ref`, so a retried delivery never claims a second key.
- The buyer's return redirect is a UI hint, never a fulfillment signal: only a
  signed `payment.succeeded` with `status: 'succeeded'` claims a key.
- `/download?…&ref=…` uses the random reference id as the lookup token for a
  claimed key — a long random string only the buyer's own redirect carries. Keys
  are additionally sent by the purchase receipt; keep treating the confirmation
  email as the durable copy.
- The license signing seed exists only on the vendor machine (`issue_license.rs`).

## Alternative processors

`stripe` (Checkout Session + `/api/webhooks/stripe`) and `lemonsqueezy` (Fast
Links + `/api/webhooks/lemonsqueezy`) implement the same `PaymentProvider` seam
and the same fulfillment path, so switching is a matter of `FOVEA_PAYMENT_PROVIDER`
plus their `FOVEA_STRIPE_*` / `FOVEA_LS_*` env values. They share the orders table
and the license pool with Dodo.
