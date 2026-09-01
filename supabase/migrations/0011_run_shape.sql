-- The two facts a cost row needs that the cost row cannot derive: how big the
-- site was, and how many sections the build was actually going to pay for.
--
-- Without them a hundred measured rows still cannot answer "what will THIS site
-- cost", because the per-site drivers (size for the scan, N for the build) are
-- only recoverable by re-deriving them from the bundle — which is gone by then —
-- or by counting stage_usage entries after the fact, which cannot distinguish
-- "the build had 7 sections" from "the build died after 7 of 12".
alter table public.scans
  -- Size of the scanned bundle in bytes, written on the FIRST detect pass, before
  -- any model call. Recorded even for a scan that later fails, because a failed
  -- scan's cost is a real data point and needs its size to be interpretable.
  add column if not exists bundle_bytes integer,
  -- What the build was planned to be, written at the end of rebuild part 1 from
  -- the deterministic ledger — before a single section is built:
  --   { sections_total, sections_widget, sections_model, components, facts }
  -- sections_model is N: the sections that cost a model call. sections_widget are
  -- carried verbatim and cost nothing, which is why sections_total on its own
  -- over-predicts the build. Knowing N before the build is what turns this table
  -- from a record of what things cost into an estimate of what they will cost.
  add column if not exists build_shape jsonb;

comment on column public.scans.bundle_bytes is
  'Size of the scanned bundle in bytes. Written on the first detect pass, before any model call, so a failed scan still records what it was scanning.';
comment on column public.scans.build_shape is
  'What the build was planned to be, from the deterministic ledger at rebuild part 1: {sections_total, sections_widget, sections_model, components, facts}. sections_model is the N the build-cost equation multiplies; widget sections are built without a model call and cost nothing.';

-- Same guard as 0006/0010: these columns are only as protected as the row.
do $$
begin
  if not (
    select relrowsecurity from pg_class
    where oid = 'public.scans'::regclass
  ) then
    raise exception 'public.scans has RLS disabled — refusing to add run-shape columns';
  end if;
end $$;
