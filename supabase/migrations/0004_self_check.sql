-- What the rebuild's own audit of its own output found.
--
-- The rebuild is measured on what it clears, but it also introduces: the best
-- run on record cleared 17 signals and introduced 4. selfCheck re-runs the
-- deterministic detector over the assembled page, repairs what code can repair,
-- and re-runs it again to prove the repair landed. Storing the result makes the
-- next run comparable against a record rather than a memory.
--
--   repaired      — ids proven absent by the second pass
--   unrepaired    — ids a repair targeted and did not clear (a carried widget's
--                   own CSS is deliberately left alone, so its #64 survives)
--   still_present — every mechanically detected id left in the shipped page
alter table public.scans
  add column if not exists self_check jsonb;

comment on column public.scans.self_check is
  'Result of the rebuild''s deterministic self-audit: {repaired, unrepaired, still_present}.';
