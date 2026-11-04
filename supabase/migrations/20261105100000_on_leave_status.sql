-- #304 (LV-04): the On leave status. Its own migration, like the anticheat kinds: a new
-- enum value can only be used once the transaction that added it has committed, and the
-- time off migration that follows (20261105110000_time_off) writes it.
--
-- On leave replaces Off shift for someone who isn't clocked in on an approved leave day or
-- a holiday that applies to them. It never applies while they are clocked in: whoever
-- clocks in anyway is tracked as normal.
alter type public.presence_status add value if not exists 'on_leave' after 'off_shift';
