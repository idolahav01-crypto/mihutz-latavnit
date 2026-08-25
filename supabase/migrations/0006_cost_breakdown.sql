-- Per-site cost breakdown by C-category (spec: pricing model).
--
-- stage_usage already records the ACTUAL cost of every single Claude call, but
-- one call per line: three detect parts, a rebuild_design, a rebuild_shell, one
-- rebuild_section_N per section. To answer "what did each C cost us for THIS
-- site" you had to sum those by hand. This column stores the rollup so the real
-- cost of each stage is one field on the row, ready to become the prior-knowledge
-- the build-cost estimate is calibrated from.
--
-- It is DERIVED from stage_usage (recomputed on every recordStageUsage write),
-- so it never disagrees with total_cost_usd and needs no separate backfill:
--   { scan_usd, scan_after_usd, design_usd, shell_usd,
--     sections_usd, section_count, per_section_usd, other_usd, total_usd }
alter table public.scans
  add column if not exists cost_breakdown jsonb;

comment on column public.scans.cost_breakdown is
  'Actual per-C cost for this site, rolled up from stage_usage: {scan_usd, scan_after_usd, design_usd, shell_usd, sections_usd, section_count, per_section_usd, other_usd, total_usd}. Recomputed on every stage write; total_usd reconciles with total_cost_usd.';

-- RLS: scans is owner-scoped from 0001 and policies apply to the row, so this
-- column inherits that protection with no new policy. Guard, not a change.
do $$
begin
  if not (
    select relrowsecurity from pg_class
    where oid = 'public.scans'::regclass
  ) then
    raise exception 'public.scans has RLS disabled — refusing to add cost_breakdown';
  end if;
end $$;
