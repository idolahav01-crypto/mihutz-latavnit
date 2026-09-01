-- The cost rollup now records WHICH MODEL charged for each C, and separates
-- money that bought nothing from money that bought a section.
--
-- Nothing to migrate: cost_breakdown is derived from stage_usage and rewritten
-- on every recordStageUsage, so the new keys appear on any row the pipeline
-- touches again. This migration exists to keep the column's documented shape
-- true, because that comment is what the pricing work reads it by.
--
-- What changed, and why each field had to exist:
--   models              which model ran each part of the run, by family:
--                       "sonnet" for the scan, "opus" for design/shell/sections.
--   model_ids           the exact versions behind those families. Both are kept
--                       because they answer different questions: the family is
--                       how the pipeline is reasoned about, the version is what
--                       the rate table is keyed on. Every measured constant
--                       (C_scan, C_section...) is only valid for the model that
--                       produced it, so a model swap that is invisible here
--                       silently invalidates the whole calibration. A part that
--                       genuinely spanned two families reads "opus+sonnet".
--   failed_calls        calls that were billed and produced nothing usable —
--   failed_usd          a timeout mid-stream or a malformed reply. These used to
--                       be recorded as $0.00 (the usage was thrown away with the
--                       error), which is precisely why the 30% waste factor was
--                       a guess. Their cost IS included in the C buckets and in
--                       total_usd; these two fields say how much of it was waste.
--   design_reproposal_* extra design directions the user asked for. Uncapped and
--                       per-run, so they are kept out of design_usd (which must
--                       stay a per-call constant) and out of other_usd (which is
--                       for unrelated pipelines).
--   section_count       now counts sections BUILT, not section calls made, and
--   per_section_usd     is the cost of those calls only. A failed retry used to
--                       inflate N and deflate the per-section cost at once.
comment on column public.scans.cost_breakdown is
  'Actual per-C cost for this site, rolled up from stage_usage: {scan_usd, scan_after_usd, design_usd, design_reproposal_usd, design_reproposal_count, shell_usd, sections_usd, section_count, per_section_usd, other_usd, failed_calls, failed_usd, models:{scan,scan_after,design,shell,sections,other} (family name per part), model_ids:{...} (exact versions), total_usd}. section_count/per_section_usd count only calls that built a section; failed_* are billed calls that produced nothing. Recomputed on every stage write; total_usd reconciles with total_cost_usd.';

-- Same guard as 0006: this column is only as protected as the row it sits on.
do $$
begin
  if not (
    select relrowsecurity from pg_class
    where oid = 'public.scans'::regclass
  ) then
    raise exception 'public.scans has RLS disabled — refusing to document cost_breakdown';
  end if;
end $$;
