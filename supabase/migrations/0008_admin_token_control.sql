-- תשנה — manual control of token balances
--
-- The rule this file exists to enforce: a balance is money, so who may change
-- one is decided by Postgres, never by the page. The admin page is only a form
-- over the two functions below — signing in as an admin is what grants the
-- power, and a browser that lies about being an admin gets an exception, not a
-- write. Every change is written to a ledger with who did it, so a balance can
-- always be explained afterwards.

-- ============================================================
-- who is an admin
-- ============================================================
create table if not exists public.admins (
  user_id  uuid primary key references auth.users (id) on delete cascade,
  note     text,
  added_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- SECURITY DEFINER on purpose: it reads a table whose own policy calls it, and
-- a policy that recurses into itself deadlocks. Definer rights skip RLS here,
-- which is safe because the function reads exactly one row keyed by auth.uid()
-- and returns a boolean.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

-- An admin may read the roster. Nobody may write it from a browser: there is
-- deliberately no insert, update or delete policy, so the only way to make
-- somebody an admin is a statement run against the database directly. That is
-- the point — an admin page that can appoint admins is a privilege ladder.
drop policy if exists "admins_select_admins" on public.admins;
create policy "admins_select_admins" on public.admins
  for select using (public.is_admin());

-- ============================================================
-- the ledger: what changed, by how much, who did it, and why
-- ============================================================
create table if not exists public.token_ledger (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  delta         integer not null,
  balance_after integer not null,
  reason        text,
  actor         uuid references auth.users (id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists token_ledger_user_id_created_at_idx
  on public.token_ledger (user_id, created_at desc);

-- RLS on with no policy at all: unreachable from any browser, by anyone. The
-- ledger is written by the function below, under definer rights.
alter table public.token_ledger enable row level security;

-- ============================================================
-- what the admin page is allowed to ask for
-- ============================================================

-- Every wallet with the account it belongs to. auth.users is not exposed over
-- the API, so this is the only way an admin can put a balance next to an email.
-- The is_admin() guard does all the work here, because definer rights have
-- already skipped RLS by the time the body runs.
create or replace function public.admin_list_wallets()
returns table (user_id uuid, email text, balance integer, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
    select u.id,
           u.email::text,
           coalesce(w.balance, 0),
           w.updated_at
    from auth.users u
    left join public.token_wallets w on w.user_id = u.id
    order by coalesce(w.updated_at, u.created_at) desc;
end;
$$;

-- Set one wallet to an exact number. Exact, not a delta: the admin is reading
-- the current balance off the screen and typing what it should be, and a form
-- that applies a difference is a form that double-applies on a second click.
-- The delta is worked out here and recorded, so the ledger still reads as a
-- history of movements.
create or replace function public.admin_set_balance(
  target      uuid,
  new_balance integer,
  reason      text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  before_balance integer;
begin
  if not public.is_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  if new_balance is null or new_balance < 0 then
    raise exception 'balance must be zero or more';
  end if;
  if not exists (select 1 from auth.users u where u.id = target) then
    raise exception 'no such user';
  end if;

  select w.balance into before_balance
  from public.token_wallets w where w.user_id = target;
  before_balance := coalesce(before_balance, 0);

  insert into public.token_wallets (user_id, balance)
  values (target, new_balance)
  on conflict (user_id) do update
    set balance = excluded.balance, updated_at = now();

  insert into public.token_ledger (user_id, delta, balance_after, reason, actor)
  values (target, new_balance - before_balance, new_balance,
          nullif(btrim(coalesce(reason, '')), ''), auth.uid());

  return new_balance;
end;
$$;

-- Reachable by a signed-in caller only. anon has to be revoked BY NAME: this
-- project carries a default privilege that grants execute on every new function
-- in public to anon, authenticated and service_role, so "revoke from public"
-- leaves that direct grant standing and an unauthenticated request can still
-- reach the function. The is_admin() guard inside would refuse it anyway —
-- auth.uid() is null and null is in nobody's roster — but a function that
-- edits balances should not be callable without a session at all.
revoke all on function public.is_admin() from public, anon;
revoke all on function public.admin_list_wallets() from public, anon;
revoke all on function public.admin_set_balance(uuid, integer, text) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.admin_list_wallets() to authenticated;
grant execute on function public.admin_set_balance(uuid, integer, text) to authenticated;
