-- תשנה — small readable surfaces over one wide table
--
-- public.scans is 29 columns wide and holds four jsonb blobs. That is right
-- for a table the pipeline writes to, and useless for a person opening the
-- Table Editor to ask "how much did August cost us". So: five views, each
-- answering one question, each narrow enough to read without scrolling.
--
-- Nothing here moves or copies data. A view is a saved question, so these
-- cannot drift from the truth and cost nothing to keep.
--
--   customers      one row per account: who, balance, how much they have run
--   scan_log       one row per run: what went in, what came out, what it cost
--   build_costs    the cost_breakdown blob, unpacked into columns
--   cost_by_month  what we spent, by month
--   token_log      every balance change, in words
--
-- ⚠ These are reporting surfaces for the two of us in the Supabase dashboard,
-- and every one of them crosses account boundaries. Supabase grants select on
-- anything new in public to anon and authenticated by default, which would put
-- every customer's runs on the public API — so each view has those grants
-- revoked by name at the bottom of this file. The admin page does NOT read
-- these; it goes through admin_customers() and admin_scan_log(), which check
-- is_admin() first.

-- ============================================================
-- customers — the roster, and what each one has done
-- ============================================================
create or replace view public.customers as
select
  u.email::text,
  u.created_at::date                                        as joined,
  coalesce(w.balance, 0)                                    as tokens,
  count(s.id)                                               as runs,
  count(s.id) filter (where s.status = 'done')              as done,
  count(s.id) filter (where s.status = 'error')             as failed,
  count(s.id) filter (where s.pipeline_status is not null)  as builds,
  round(sum(coalesce(s.total_cost_usd, 0))::numeric, 2)     as cost_usd,
  max(s.created_at)::date                                   as last_run,
  u.id                                                      as user_id
from auth.users u
left join public.token_wallets w on w.user_id = u.id
left join public.scans s         on s.user_id = u.id
group by u.id, u.email, u.created_at, w.balance
order by count(s.id) desc;

-- ============================================================
-- scan_log — one line per run, in the order they happened
-- ============================================================
create or replace view public.scan_log as
select
  s.created_at::timestamp(0)              as ran_at,
  u.email::text,
  s.source_type,
  left(coalesce(s.source_ref, ''), 48)    as source,
  s.status,
  s.pipeline_status                       as build_status,
  s.files_scanned                         as files,
  s.ai_fingerprint_score                  as score_before,
  s.ai_fingerprint_score_after            as score_after,
  -- the number the product is actually judged on: how far the score fell
  case when s.ai_fingerprint_score_after is not null
       then s.ai_fingerprint_score - s.ai_fingerprint_score_after end as improved_by,
  round(coalesce(s.total_cost_usd, 0)::numeric, 2) as cost_usd,
  left(coalesce(s.error, ''), 120)        as error,
  s.id                                    as scan_id
from public.scans s
join auth.users u on u.id = s.user_id
order by s.created_at desc;

-- ============================================================
-- build_costs — the cost_breakdown blob as columns
-- Only rows written since the breakdown column was added carry one, so this
-- view is deliberately narrower than scan_log rather than full of nulls.
-- ============================================================
create or replace view public.build_costs as
select
  s.created_at::timestamp(0)                              as ran_at,
  u.email::text,
  round((s.cost_breakdown ->> 'scan_usd')::numeric, 3)       as scan_usd,
  round((s.cost_breakdown ->> 'scan_after_usd')::numeric, 3) as rescan_usd,
  round((s.cost_breakdown ->> 'design_usd')::numeric, 3)     as design_usd,
  round((s.cost_breakdown ->> 'shell_usd')::numeric, 3)      as shell_usd,
  round((s.cost_breakdown ->> 'sections_usd')::numeric, 3)   as sections_usd,
  (s.cost_breakdown ->> 'section_count')::int                as sections,
  round((s.cost_breakdown ->> 'per_section_usd')::numeric, 3) as per_section_usd,
  round((s.cost_breakdown ->> 'other_usd')::numeric, 3)      as other_usd,
  round((s.cost_breakdown ->> 'total_usd')::numeric, 2)      as total_usd,
  s.id                                                       as scan_id
from public.scans s
join auth.users u on u.id = s.user_id
where s.cost_breakdown is not null
order by s.created_at desc;

-- ============================================================
-- cost_by_month — what the AI cost us, month by month
-- ============================================================
create or replace view public.cost_by_month as
select
  to_char(date_trunc('month', s.created_at), 'YYYY-MM')          as month,
  count(*)                                                       as runs,
  count(*) filter (where s.pipeline_status is not null)           as builds,
  round(sum(coalesce(s.total_cost_usd, 0))::numeric, 2)           as cost_usd,
  round(avg(nullif(s.total_cost_usd, 0))::numeric, 2)             as avg_per_run_usd
from public.scans s
group by 1
order by 1 desc;

-- ============================================================
-- token_log — every balance change, readable
-- ============================================================
create or replace view public.token_log as
select
  l.created_at::timestamp(0)  as changed_at,
  u.email::text,
  l.delta,
  l.balance_after,
  l.reason,
  -- who moved it: an admin through the page, or a person at the database
  coalesce(a.email::text, '(database)') as changed_by
from public.token_ledger l
join auth.users u on u.id = l.user_id
left join auth.users a on a.id = l.actor
order by l.created_at desc;

-- ============================================================
-- Off the public API. Every one of these reads across accounts, so the two
-- roles PostgREST speaks as must not be able to select from them at all.
-- ============================================================
revoke all on public.customers     from public, anon, authenticated;
revoke all on public.scan_log      from public, anon, authenticated;
revoke all on public.build_costs   from public, anon, authenticated;
revoke all on public.cost_by_month from public, anon, authenticated;
revoke all on public.token_log     from public, anon, authenticated;

-- ============================================================
-- What the admin page is allowed to read. Same shape as the views, same
-- is_admin() wall as the wallet functions — the page never touches the
-- views directly, so the API surface stays exactly three functions wide.
-- ============================================================
create or replace function public.admin_customers()
returns table (
  email text, joined date, tokens integer, runs bigint, done bigint,
  failed bigint, builds bigint, cost_usd numeric, last_run date
)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return query
    select c.email, c.joined, c.tokens, c.runs, c.done,
           c.failed, c.builds, c.cost_usd, c.last_run
    from public.customers c;
end;
$$;

create or replace function public.admin_scan_log(rows_wanted integer default 50)
returns table (
  ran_at timestamp, email text, source_type text, source text, status text,
  build_status text, score_before integer, score_after integer,
  improved_by integer, cost_usd numeric, error text
)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
  return query
    select s.ran_at, s.email, s.source_type, s.source, s.status,
           s.build_status, s.score_before, s.score_after,
           s.improved_by, s.cost_usd, s.error
    from public.scan_log s
    limit greatest(1, least(coalesce(rows_wanted, 50), 500));
end;
$$;

revoke all on function public.admin_customers() from public, anon;
revoke all on function public.admin_scan_log(integer) from public, anon;
grant execute on function public.admin_customers() to authenticated;
grant execute on function public.admin_scan_log(integer) to authenticated;
