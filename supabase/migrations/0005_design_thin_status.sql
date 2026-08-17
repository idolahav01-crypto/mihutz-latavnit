-- pipeline_status gains "design_thin", the design floor's refusal.
--
-- No schema change is required (the column is text and the dashboard's
-- DELIVERABLE list is the gate), so this migration exists to record the value
-- and what it means alongside the other statuses.
--
-- A rebuild can now be withheld for two different reasons:
--   content_loss  — the result lost words, numbers or a script's DOM
--   design_thin   — the result kept everything and drained the design language
--
-- The second one exists because the audit only measures what is WRONG. Signals
-- live in visual devices, so removing the devices removes the signals: one run
-- cleared 30 signals, scored 50 -> 19, and shipped 47 colours reduced to 12
-- with every gradient and shadow gone. Nothing was broken. Nothing in the
-- system could see it either.
comment on column public.scans.pipeline_status is
  'proposed | applying | applied | qa | qa_passed | qa_failed | needs_human | content_loss | design_thin';
