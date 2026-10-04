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

-- ── Lock it down ──────────────────────────────────────────────────────────
-- RLS on with zero policies = deny all for anon/authenticated. The site's
-- server uses service_role (bypasses RLS). Admin day-to-day happens through
-- the Supabase dashboard, which also uses the service role.
alter table public.orders       enable row level security;
alter table public.license_pool enable row level security;

revoke all on public.orders       from anon, authenticated;
revoke all on public.license_pool from anon, authenticated;
