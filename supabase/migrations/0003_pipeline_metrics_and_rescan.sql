-- מחוץ לתבנית — pipeline metrics (spec §7) + before/after re-detect
--
-- Purely additive to 0002. Two gaps this closes:
--
--  1. METRICS. Every stage already gets `usage` back from the Messages API
--     (including cache_read_input_tokens) but threw it away. `stage_usage`
--     stores one entry per stage run so we can report tokens, $ cost, cache-hit
--     rate, and wall-clock per stage — and `total_cost_usd` gives the per-scan
--     number without having to sum JSON in the client.
--
--  2. BEFORE/AFTER. Stage 1 is re-run against the EDITED code so the user sees
--     a real new fingerprint score rather than being told "trust us". The
--     original numbers already live in ai_fingerprint_score / present_count /
--     detection; the *_after columns hold the re-detect result beside them.
--
-- Nothing here is dropped or rewritten; existing scans keep working with these
-- columns null.

alter table public.scans
  -- [{stage, model, effort, input_tokens, output_tokens,
  --   cache_read_input_tokens, cache_creation_input_tokens,
  --   cost_usd, duration_ms, at}]
  add column if not exists stage_usage      jsonb   not null default '[]'::jsonb,
  add column if not exists total_cost_usd   numeric(10, 4) not null default 0,
  -- Stage 1 re-run on the edited bundle.
  add column if not exists detection_after           jsonb,
  add column if not exists ai_fingerprint_score_after integer,
  add column if not exists present_count_after        integer,
  add column if not exists rescanned_at              timestamptz;

comment on column public.scans.stage_usage is
  'One entry per pipeline stage run: token usage, cost, and duration. Appended to, never rewritten.';
comment on column public.scans.ai_fingerprint_score_after is
  'Fingerprint score from re-running stage 1 on the edited code. Compare against ai_fingerprint_score for the before/after report.';

-- RLS: scans is already owner-scoped ("user_id = auth.uid()") from 0001, and
-- policies apply to the row, not to individual columns — so the columns added
-- here and in 0002 inherit that protection with no new policy. Same for the
-- edited bundle at {user_id}/{scan_id}/edited-bundle.txt, which sits under the
-- existing private "scans" bucket prefix policy. This block is a guard, not a
-- change: if RLS were ever off on scans, the new columns would be world-readable.
do $$
begin
  if not (
    select relrowsecurity from pg_class
    where oid = 'public.scans'::regclass
  ) then
    raise exception 'public.scans has RLS disabled — refusing to add pipeline columns';
  end if;
end $$;
