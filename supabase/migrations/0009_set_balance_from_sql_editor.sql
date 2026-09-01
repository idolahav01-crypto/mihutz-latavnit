-- תשנה — changing a balance from the Supabase SQL editor
--
-- admin_set_balance() cannot be used there. It asks is_admin(), is_admin()
-- asks auth.uid(), and auth.uid() is null outside a request carrying a JWT —
-- so the SQL editor, which runs as postgres with no session, is refused by its
-- own admin function. That is correct: the guard is about who is signed in,
-- and nobody is.
--
-- Editing public.token_wallets by hand would work, because postgres is past
-- RLS. But it would leave no ledger row, and a balance that changed with no
-- record of who moved it or why is exactly what the ledger exists to prevent.
--
-- So: one function for the SQL editor, doing both writes together.
--
--   select * from public.set_balance_by_email('someone@gmail.com', 25, 'manual credit');
--
-- actor is recorded as auth.uid(), which is null here — deliberately. A null
-- actor is the honest record of "changed at the database, not by a signed-in
-- admin", and it is distinguishable from a change made through the admin page.

create or replace function public.set_balance_by_email(
  p_email   text,
  p_balance integer,
  p_reason  text default null
)
returns table (email text, was integer, is_now integer, delta integer)
language plpgsql
volatile
-- SECURITY INVOKER (the default) on purpose: this needs no borrowed rights.
-- It is reachable only by a role that already owns the tables, which is the
-- whole point of the grants at the bottom.
set search_path = public, auth
as $$
declare
  target_id uuid;
  before_balance integer;
begin
  if p_balance is null or p_balance < 0 then
    raise exception 'balance must be zero or more';
  end if;

  select u.id into target_id from auth.users u where lower(u.email) = lower(btrim(p_email));
  -- Loudly, rather than updating nothing: a typo in an address must not look
  -- like a successful change.
  if target_id is null then
    raise exception 'no account with the email %', p_email;
  end if;

  select w.balance into before_balance
  from public.token_wallets w where w.user_id = target_id;
  before_balance := coalesce(before_balance, 0);

  insert into public.token_wallets (user_id, balance)
  values (target_id, p_balance)
  on conflict (user_id) do update
    set balance = excluded.balance, updated_at = now();

  insert into public.token_ledger (user_id, delta, balance_after, reason, actor)
  values (target_id, p_balance - before_balance, p_balance,
          nullif(btrim(coalesce(p_reason, '')), ''), auth.uid());

  return query select p_email, before_balance, p_balance, p_balance - before_balance;
end;
$$;

-- Nobody who reaches this database over the API may call it — not a visitor,
-- not a signed-in user, not even the service role. It is for a human at the
-- SQL editor, and the table owner keeps execute rights implicitly.
revoke all on function public.set_balance_by_email(text, integer, text)
  from public, anon, authenticated, service_role;
