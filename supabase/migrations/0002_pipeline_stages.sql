-- מחוץ לתבנית — pipeline stages 2/4/5 storage
-- Stage 1 already writes detection + site_profile onto scans. These columns add
-- the artifacts produced by the design (2), apply (4) and QA (5) stages. The
-- edited file bundle itself lives in the existing private "scans" storage bucket
-- at {user_id}/{scan_id}/edited-bundle.txt (same owner-scoped RLS as the input
-- bundle), so no new bucket or policy is required here.

alter table public.scans
  add column if not exists design_direction jsonb,
  add column if not exists proposals        jsonb,
  add column if not exists approved_fixes    jsonb,
  add column if not exists change_log        jsonb,
  add column if not exists qa_verdict        jsonb,
  add column if not exists qa_rounds         integer not null default 0,
  add column if not exists pipeline_status   text;

-- pipeline_status tracks how far the fix pipeline has progressed for a scan.
-- null = detection only (stage 1). The rest mirror the pipeline stages.
alter table public.scans
  drop constraint if exists scans_pipeline_status_check;
alter table public.scans
  add constraint scans_pipeline_status_check
  check (pipeline_status is null or pipeline_status in (
    'proposed',     -- stage 2 done: design_direction + proposals ready for approval
    'applying',     -- stage 4 in flight
    'applied',      -- stage 4 done: edited bundle + change_log written
    'qa',           -- stage 5 in flight
    'qa_passed',    -- stage 5 verdict pass=true
    'qa_failed',    -- stage 5 verdict pass=false (may reapply)
    'needs_human'   -- exhausted reapply rounds; left for manual review
  ));
