-- תשנה — token wallets
-- What the customer has left to spend. The dashboard header and the store
-- both read this row; nothing in the browser may write it, because every
-- change to a balance is a movement of money and belongs to the server.

create table if not exists public.token_wallets (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  balance    integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

alter table public.token_wallets enable row level security;

-- Owner reads their own balance. There is deliberately no insert, update or
-- delete policy: a wallet is written by the service role only.
drop policy if exists "token_wallets_select_own" on public.token_wallets;
create policy "token_wallets_select_own" on public.token_wallets
  for select using (auth.uid() = user_id);

-- public.touch_updated_at() is defined in 0001_scans_and_tokens.sql
drop trigger if exists token_wallets_touch_updated_at on public.token_wallets;
create trigger token_wallets_touch_updated_at
  before update on public.token_wallets
  for each row execute function public.touch_updated_at();
