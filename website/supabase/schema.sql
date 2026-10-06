-- Fovea website — Supabase schema (run once in the Supabase SQL Editor)
--
-- Design follows the commerce seam rules in website/lib/commerce.ts:
--   * The website never touches image data — this database records commerce
--     facts (orders, license keys), never customer images.
--   * The website never mints a license. Keys are issued offline by the
--     vendor tool (src-tauri/examples/issue_license.rs) with an Ed25519 seed
--     that is NOT stored anywhere here. This database only holds keys that
--     already exist, and hands exactly one out per paid order.
--
-- Access model: Row Level Security is enabled with NO policies, which denies
-- everything to anon/authenticated roles. The website talks to these tables
-- exclusively with the service_role key, which bypasses RLS. Nothing here is
-- ever called from the browser.

-- ── Orders ────────────────────────────────────────────────────────────────
-- One row per checkout. Created 'pending' when a Stripe Checkout Session is
-- opened (or directly by the webhook if the pre-write failed), moved to
-- 'paid'/'fulfilled' when Stripe confirms payment via webhook.
create table if not exists public.orders (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  provider      text not null default 'stripe',
  external_id   text unique,                -- Stripe Checkout Session id (cs_…)
  tier          text not null check (tier in ('pro','studio')),
  edition       text not null check (edition in ('pro','studio')),
  email         text,
  amount_total  integer check (amount_total is null or amount_total >= 0),  -- cents
  currency      text,
  status        text not null default 'pending'
                check (status in ('pending','paid','fulfilled','canceled','refunded')),
  license_key   text,                       -- filled at fulfillment
  license_id    text,                       -- payload id inside the key
  metadata      jsonb not null default '{}'::jsonb
);

create index if not exists orders_status_idx on public.orders (status);

-- ── License pool ──────────────────────────────────────────────────────────
-- Pre-issued (offline-signed) keys waiting to be sold. Fill it with the
-- vendor tool + website/scripts/import-license-keys.mjs. Each key is handed
-- out at most once (see claim_license_key below).
create table if not exists public.license_pool (
  key         text primary key,             -- full key, starts with FOVEA1.
  edition     text not null check (edition in ('pro','studio')),
  license_id  text not null unique,         -- the payload "id" the vendor tool generated
  issued_at   timestamptz not null default now(),
  claimed_at  timestamptz,
  order_id    uuid references public.orders(id)
);

-- Partial index: the claim query only ever looks at unclaimed keys.
create index if not exists license_pool_unclaimed_idx
  on public.license_pool (edition, issued_at)
  where claimed_at is null;

-- ── Atomic claim RPC ──────────────────────────────────────────────────────
-- The webhook calls this (through PostgREST) to take one unclaimed key of the
-- requested edition. FOR UPDATE SKIP LOCKED makes concurrent payments safe:
-- each claim takes a different key, never two orders sharing one key.
create or replace function public.claim_license_key(p_edition text, p_order_id uuid)
returns table (claimed_key text, claimed_license_id text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_lid text;
begin
  if p_edition not in ('pro','studio') then
    raise exception 'invalid edition: %', p_edition;
  end if;

  update public.license_pool lp
     set claimed_at = now(),
         order_id   = p_order_id
   where lp.key = (
     select key
       from public.license_pool
      where edition = p_edition
        and claimed_at is null
      order by issued_at
      limit 1
      for update skip locked
   )
   returning lp.key, lp.license_id
      into v_key, v_lid;

  return query select v_key, v_lid;
end;
$$;

-- Only the service role (the website's server) may execute the claim.
revoke all on function public.claim_license_key(text, uuid) from public, anon, authenticated;
grant execute on function public.claim_license_key(text, uuid) to service_role;

-- ── Merge order metadata RPC ──────────────────────────────────────────────
-- PostgREST PATCH replaces a jsonb column wholesale; this keeps a real merge
-- (used to record the Stripe payment_intent on the order row).
create or replace function public.merge_order_metadata(p_id uuid, p_patch jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.orders
     set metadata  = coalesce(metadata, '{}'::jsonb) || p_patch,
         updated_at = now()
   where id = p_id;
$$;

revoke all on function public.merge_order_metadata(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.merge_order_metadata(uuid, jsonb) to service_role;

-- ── Free plan usage meter ───────────────────────────────────────────────
-- The free allowance is 10 source images per calendar month, and this table is
-- the authority on that count — not the user's machine. Two properties matter:
--
--   * `period` is assigned from the SERVER's clock inside the RPC. Winding a
--     Windows clock back to the 1st cannot reopen a month that is already spent,
--     because the month is not the client's to name.
--   * `FREE_MONTHLY_LIMIT` lives here, not in the request. A client that sends
--     no limit cannot raise one.
--
-- Identity is `install_id`: a stable per-machine hash the app derives from the
-- Windows MachineGuid (services/license/machine.rs). It survives deleting app
-- data and reinstalling the app, which is what a local quota.json file could not
-- do. It does not survive deliberately rewriting the registry key — that is the
-- remaining, and much higher, bar. No personal data: it is a hash, not a name.
--
-- The desktop app never talks to Supabase. It calls /api/usage on this site,
-- which calls these functions as service_role.
create table if not exists public.free_usage (
  install_id  text primary key check (install_id ~ '^[a-z0-9]{8,64}$'),
  period      text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  used        integer not null default 0 check (used >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- The single source of truth for the free plan's allowance. The shipped app
-- reads this value back in every response; src-tauri/src/services/quota.rs
-- keeps the same number as its offline ceiling.
create or replace function public.free_monthly_limit()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 10;
$$;

-- A second, wider ceiling per source network. Without it this whole meter is
-- trivial to beat: the meter id is a client-supplied string, so minting a new
-- one would mint a fresh allowance. A household or office NAT legitimately
-- carries several machines, so this bucket sits well above the per-install
-- allowance — it is a spam brake, not a device census.
--
-- The route hashes the requester's address with a server-side salt and passes
-- that as the meter id (prefix `iph`), so no raw address is ever stored.
create or replace function public.free_ip_monthly_limit()
returns integer
language sql
immutable
set search_path = ''
as $$
  select 30;
$$;

-- Which allowance a meter id answers to, decided by its own prefix. A server
-- decision: no request carries a limit, so no client can raise its own.
create or replace function public.limit_for_meter(p_meter_id text)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when p_meter_id like 'iph%' then public.free_ip_monthly_limit()
    else public.free_monthly_limit()
  end;
$$;

-- Spend `p_count` credits on one meter. Atomic: the month rollover and the
-- increment happen in one statement, so two concurrent batches cannot both see
-- the pre-increment balance and overrun it.
--
-- The output column is named monthly_limit: `limit` is a reserved word and
-- cannot be an unquoted column name, so this function would not even create.
create or replace function public.spend_credits(p_meter_id text, p_count integer)
returns table (period text, used integer, remaining integer, monthly_limit integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now        text    := to_char((now() at time zone 'utc'), 'YYYY-MM');
  v_limit      integer := public.limit_for_meter(p_meter_id);
  v_row_period text;
  v_row_used   integer;
begin
  if p_meter_id is null or p_meter_id !~ '^[a-z0-9]{8,64}$' then
    raise exception 'invalid meter id';
  end if;
  -- An upper bound here, so one request cannot write an absurd balance. A full
  -- batch is well below it; src-tauri's own batch cap is the real ceiling.
  if p_count is null or p_count < 1 or p_count > 1000 then
    raise exception 'invalid credit count: %', p_count;
  end if;

  insert into public.free_usage as u (install_id, period, used, updated_at)
  values (p_meter_id, v_now, p_count, now())
  on conflict (install_id) do update
    set period     = excluded.period,
        -- A new server month resets the count; the same month accumulates.
        -- `u` is the row as it was before this update, so the comparison reads
        -- the stored period against the server period, not against what this
        -- statement is about to write.
        used       = (case when u.period = excluded.period then u.used else 0 end)
                     + excluded.used,
        updated_at = now()
  returning u.period, u.used into v_row_period, v_row_used;

  return query select v_row_period, v_row_used,
                       greatest(v_limit - v_row_used, 0), v_limit;
end;
$$;

-- Read the meter without spending — the app calls this at startup to show the
-- balance and to learn the authoritative date.
create or replace function public.peek_credits(p_meter_id text)
returns table (period text, used integer, remaining integer, monthly_limit integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now        text    := to_char((now() at time zone 'utc'), 'YYYY-MM');
  v_limit      integer := public.limit_for_meter(p_meter_id);
  v_row_period text;
  v_row_used   integer;
begin
  if p_meter_id is null or p_meter_id !~ '^[a-z0-9]{8,64}$' then
    raise exception 'invalid meter id';
  end if;

  select u.period, u.used into v_row_period, v_row_used
    from public.free_usage u
   where u.install_id = p_meter_id;

  -- No row yet, or the server month has turned over: a full allowance either
  -- way. A SELECT INTO with no rows leaves both targets null, which is exactly
  -- the branch an unseen meter falls into.
  if v_row_period is null or v_row_period <> v_now then
    return query select v_now, 0, v_limit, v_limit;
  end if;

  return query select v_now, v_row_used, greatest(v_limit - v_row_used, 0), v_limit;
end;
$$;

revoke all on function public.free_monthly_limit()           from public, anon, authenticated;
revoke all on function public.free_ip_monthly_limit()        from public, anon, authenticated;
revoke all on function public.limit_for_meter(text)          from public, anon, authenticated;
revoke all on function public.spend_credits(text, integer)   from public, anon, authenticated;
revoke all on function public.peek_credits(text)             from public, anon, authenticated;
grant execute on function public.free_monthly_limit()        to service_role;
grant execute on function public.free_ip_monthly_limit()     to service_role;
grant execute on function public.limit_for_meter(text)       to service_role;
grant execute on function public.spend_credits(text, integer) to service_role;
grant execute on function public.peek_credits(text)          to service_role;

-- ── Lock it down ──────────────────────────────────────────────────────────
-- RLS on with zero policies = deny all for anon/authenticated. The site's
-- server uses service_role (bypasses RLS). Admin day-to-day happens through
-- the Supabase dashboard, which also uses the service role.
alter table public.orders       enable row level security;
alter table public.license_pool enable row level security;
alter table public.free_usage        enable row level security;

revoke all on public.orders       from anon, authenticated;
revoke all on public.license_pool from anon, authenticated;
revoke all on public.free_usage        from anon, authenticated;
