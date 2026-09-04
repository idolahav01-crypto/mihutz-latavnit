-- תשנה — purchases, and the one way a balance goes up because money moved
--
-- A payment provider will deliver the same webhook more than once. That is not
-- a fault, it is the design: it retries until it gets a 2xx, and a network
-- hiccup after we credited but before we answered looks exactly like a failure.
-- So "credit this order" has to be safe to run twice, and the thing that makes
-- it safe is the unique key on the provider's own reference. The second call
-- finds the row already there and returns the balance untouched.
--
-- As with the admin functions in 0008, the rule is that a balance is money and
-- Postgres decides who may change one. No browser reaches anything in here.

create table if not exists public.purchases (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  tokens        integer not null check (tokens > 0),
  gross_cents   integer not null default 0,
  provider      text    not null default 'lemonsqueezy',
  -- the provider's id for the order. UNIQUE is the whole idempotency story.
  provider_ref  text    not null,
  refunded_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (provider, provider_ref)
);

create index if not exists purchases_user_id_created_at_idx
  on public.purchases (user_id, created_at desc);

-- RLS on with no policy at all: unreachable from any browser, by anyone —
-- the same posture as token_ledger. Written by the function below under
-- definer rights, read by admins through the view at the end of this file.
alter table public.purchases enable row level security;

-- ============================================================
-- credit_tokens — add tokens for one paid order, exactly once
-- ============================================================
create or replace function public.credit_tokens(
  target       uuid,
  amount       integer,
  provider_ref text,
  gross_cents  integer default 0,
  provider     text default 'lemonsqueezy'
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  new_balance integer;
  rows_added  integer := 0;
begin
  if amount is null or amount < 1 then
    raise exception 'amount must be at least 1';
  end if;
  if provider_ref is null or btrim(provider_ref) = '' then
    raise exception 'provider_ref is required';
  end if;
  if not exists (select 1 from auth.users u where u.id = target) then
    raise exception 'no such user';
  end if;

  -- The insert is the lock. Two deliveries of the same order racing each other
  -- both reach here; one inserts, the other conflicts and credits nothing.
  insert into public.purchases (user_id, tokens, gross_cents, provider, provider_ref)
  values (target, amount, coalesce(gross_cents, 0), provider, provider_ref)
  on conflict (provider, provider_ref) do nothing;

  get diagnostics rows_added = row_count;

  if rows_added = 0 then
    select coalesce(w.balance, 0) into new_balance
    from public.token_wallets w where w.user_id = target;
    return coalesce(new_balance, 0);
  end if;

  insert into public.token_wallets (user_id, balance)
  values (target, amount)
  on conflict (user_id) do update
    set balance = public.token_wallets.balance + excluded.balance,
        updated_at = now()
  returning balance into new_balance;

  -- actor is null: nobody did this, a payment did. The ledger already carries
  -- who-and-when for hand edits, and a purchase should read differently.
  insert into public.token_ledger (user_id, delta, balance_after, reason, actor)
  values (target, amount, new_balance, 'purchase ' || provider || ' ' || provider_ref, null);

  return new_balance;
end;
$$;

-- Nobody signed in may call this, and neither may anon. It is for the webhook,
-- which runs as the service role. Revoking by name because this project's
-- default privileges grant execute on every new function in public to anon,
-- authenticated and service_role — "revoke from public" alone leaves those
-- direct grants standing.
revoke all on function public.credit_tokens(uuid, integer, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.credit_tokens(uuid, integer, text, integer, text)
  to service_role;

-- ============================================================
-- mark_purchase_refunded — record it; do not claw the tokens back
-- ============================================================
-- A refund does not silently reverse a balance. By the time one arrives the
-- tokens may already be spent, and token_wallets.balance has a check(>= 0)
-- that a blind subtraction would hit. Worse, an automatic clawback can leave a
-- customer mid-build with no tokens and no explanation. So a refund is
-- recorded, shows up on the admin desk, and a person decides what to do with
-- the balance using admin_set_balance().
create or replace function public.mark_purchase_refunded(
  provider_ref text,
  provider     text default 'lemonsqueezy'
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  hit integer;
begin
  update public.purchases p
     set refunded_at = now()
   where p.provider = mark_purchase_refunded.provider
     and p.provider_ref = mark_purchase_refunded.provider_ref
     and p.refunded_at is null;
  get diagnostics hit = row_count;
  return hit > 0;
end;
$$;

revoke all on function public.mark_purchase_refunded(text, text)
  from public, anon, authenticated;
grant execute on function public.mark_purchase_refunded(text, text) to service_role;

-- ============================================================
-- purchase_log — what was bought, for the admin desk
-- ============================================================
-- Same shape as the other reporting views in 0012: a plain view an admin reads
-- in the SQL editor, with the email joined on so a row can be recognised.
drop view if exists public.purchase_log;
create or replace view public.purchase_log as
select
  p.created_at::timestamp(0)                  as bought_at,
  u.email::text                               as email,
  p.tokens,
  round(p.gross_cents / 100.0, 2)             as paid_usd,
  p.provider,
  p.provider_ref,
  p.refunded_at::timestamp(0)                 as refunded_at
from public.purchases p
join auth.users u on u.id = p.user_id
order by p.created_at desc;
