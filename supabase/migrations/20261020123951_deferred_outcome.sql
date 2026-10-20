-- #102: a due check-in held for a call, a screen share or a presentation is recorded
-- as outcome `deferred` (CHK-03, DSH-03). A new enum value can't be used in the
-- transaction that adds it, so the value is added here and used by the next migration.
alter type public.checkin_outcome add value if not exists 'deferred';
