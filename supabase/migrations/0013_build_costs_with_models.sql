-- build_costs, rebuilt around what the cost rollup now records.
--
-- The view was written before the metering work, so it unpacks a shape that no
-- longer describes a run: it cannot say which model charged for a part, it
-- cannot separate money that bought a section from money that bought nothing,
-- and it has no column for the two per-site drivers the estimate needs (how big
-- the site was, and how many sections the build was going to pay for). The point
-- of the view is to answer "what did this site cost us" without writing SQL, so
-- a view that omits the calibration is a view that sends you back to the editor.
--
-- Dropped and recreated rather than replaced: CREATE OR REPLACE VIEW can only
-- append columns, and the readable order here puts the site next to its size and
-- the money next to the model that charged it.
drop view if exists public.build_costs;

create view public.build_costs as
select
  s.created_at::timestamp(0)                                    as ran_at,
  u.email,
  -- The per-site drivers, recorded before the work they describe was paid for.
  round(s.bundle_bytes / 1024.0)::int                           as bundle_kb,
  (s.build_shape ->> 'sections_model')::int                     as n_planned,
  (s.cost_breakdown ->> 'section_count')::int                   as n_built,
  -- Which model charged for which part of the run.
  s.cost_breakdown -> 'models' ->> 'scan'                       as scan_model,
  s.cost_breakdown -> 'models' ->> 'sections'                   as build_model,
  -- The C's, in the order the pipeline spends them.
  round((s.cost_breakdown ->> 'scan_usd')::numeric, 3)          as scan_usd,
  round((s.cost_breakdown ->> 'design_usd')::numeric, 3)        as design_usd,
  round((s.cost_breakdown ->> 'shell_usd')::numeric, 3)         as shell_usd,
  round((s.cost_breakdown ->> 'sections_usd')::numeric, 3)      as sections_usd,
  round((s.cost_breakdown ->> 'per_section_usd')::numeric, 3)   as per_section_usd,
  round((s.cost_breakdown ->> 'scan_after_usd')::numeric, 3)    as rescan_usd,
  -- Money that bought nothing: billed calls that timed out or came back
  -- unusable, and design directions the user asked to see again. Both are
  -- inside total_usd; they are broken out because they are the waste factor.
  (s.cost_breakdown ->> 'failed_calls')::int                    as failed,
  round((s.cost_breakdown ->> 'failed_usd')::numeric, 3)        as wasted_usd,
  (s.cost_breakdown ->> 'design_reproposal_count')::int         as rerolls,
  round((s.cost_breakdown ->> 'design_reproposal_usd')::numeric, 3) as reroll_usd,
  round((s.cost_breakdown ->> 'other_usd')::numeric, 3)         as other_usd,
  round((s.cost_breakdown ->> 'total_usd')::numeric, 2)         as total_usd,
  -- A row whose after-scan never finished has rescan_usd 0 because it was not
  -- measured, NOT because it was free. Averaging those in understates the cost
  -- of a whole site, so the view says which rows are safe to average.
  s.rescanned_at is not null                                    as after_scan_ok,
  s.id                                                          as scan_id
from public.scans s
join auth.users u on u.id = s.user_id
where s.cost_breakdown is not null
order by s.created_at desc;

-- Recreating the view re-applies Supabase's default grants on public, which
-- would put every account's costs on the public API. Same revoke as 0012 — this
-- crosses account boundaries and is for the dashboard only.
revoke all on public.build_costs from public, anon, authenticated;

comment on view public.build_costs is
  'One row per run: size in, sections planned vs built, which model charged for each part, the cost of every C, and what was spent on nothing. Dashboard only — revoked from anon and authenticated because it reads across accounts.';
