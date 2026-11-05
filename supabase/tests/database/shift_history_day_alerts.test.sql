-- #344: shift history (SHF-01) in the day view (public.day_shifts) and in late clock-in
-- alerts (ALR-01): a past day shows, and is checked against, the shift that applied that
-- day; today stays on the current shift. Dates are relative to today in Los Angeles
-- (Erin's zone); last week is the ISO week before this one.
begin;
create extension if not exists pgtap with schema extensions;

select plan(12);

\set org '''00000000-0000-4000-8000-000000000001'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

create temp table d as
select t.today, date_trunc('week', t.today)::date - 7 as week_from
from (select (now() at time zone 'America/Los_Angeles')::date as today) t;
grant select on d to authenticated;

-- Erin's shifts as public.day_shifts gives them for a day: "date start-end" per row.
create function pg_temp.day_shifts(p_day date) returns text
language sql as $$
  select coalesce(string_agg(format('%s %s-%s', s.day, to_char(s.start_time, 'HH24:MI'),
    to_char(s.end_time, 'HH24:MI')), ', ' order by s.day, s.start_time), 'none')
  from public.day_shifts('00000000-0000-4000-8000-0000000000c1', p_day) s
$$;

-- Day view ---------------------------------------------------------------------------------

-- Today Max moves Erin to 13:00-15:00 every day.
select pg_temp.act_as(:max);
select lives_ok(
  $$ select public.set_shifts('00000000-0000-4000-8000-0000000000c1',
       '[{"days": [1, 2, 3, 4, 5, 6, 7], "start": "13:00", "end": "15:00", "timezone": "America/Los_Angeles"}]') $$,
  'the manager edits the shift today');

select is(pg_temp.day_shifts((select week_from + 1 from d)),
  (select format('%s 09:00-17:00, %s 09:00-17:00', week_from, week_from + 1) from d),
  'last Tuesday (and the Monday before it) show the old weekday 09:00-17:00 shift');
select is(
  (select format('%s-%s', to_char(s.start_time, 'HH24:MI'), to_char(s.end_time, 'HH24:MI'))
   from d, public.day_shifts(:erin, d.today) s where s.day = d.today),
  '13:00-15:00', 'today shows the new shift');
select is(pg_temp.day_shifts((select week_from + 6 from d)), 'none',
  'last Sunday (and Saturday) had no shift, though every day has one from today');

-- Erin sees her own; another employee sees nothing; anon can't call it.
select pg_temp.act_as(:erin);
select is(pg_temp.day_shifts((select week_from + 1 from d)),
  (select format('%s 09:00-17:00, %s 09:00-17:00', week_from, week_from + 1) from d),
  'Erin reads her own past shifts');
select pg_temp.act_as(:lucas);
select is(pg_temp.day_shifts((select week_from + 1 from d)), 'none',
  'a coworker reads nothing (can_view_user)');
select pg_temp.act_as_postgres();
select ok(not has_function_privilege('anon', 'public.day_shifts(uuid, date)', 'execute'),
  'anon can''t call day_shifts');

-- Late clock-in alerts ---------------------------------------------------------------------
-- Erin has a device and no clock session. "Now" is 02:00 or 10:00 today in Los Angeles.

insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000e4', :org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-344');

create function pg_temp.at(hhmm text) returns timestamptz
language sql as $$
  select (today + hhmm::time)::timestamp at time zone 'America/Los_Angeles' from d
$$;

-- Erin's shift is `cur` (every day) from today; up to yesterday it was `old` (every day).
create function pg_temp.shifts(old_start time, old_end time, cur_start time, cur_end time)
returns void
language sql as $$
  delete from public.alerts;
  delete from public.email_outbox;
  delete from public.shifts where user_id = '00000000-0000-4000-8000-0000000000c1';
  delete from public.shift_history where user_id = '00000000-0000-4000-8000-0000000000c1';
  insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
          '{1,2,3,4,5,6,7}', cur_start, cur_end, 'America/Los_Angeles');
  insert into public.shift_history (org_id, user_id, shift_id, days, start_time, end_time,
    timezone, valid_from, valid_to)
  select '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
    gen_random_uuid(), '{1,2,3,4,5,6,7}', old_start, old_end, 'America/Los_Angeles',
    '-infinity', today
  from d;
$$;

-- Late clock-in alerts about Erin: their shift starts, local "HH:MI" (yesterday's prefixed).
create function pg_temp.late() returns text
language sql as $$
  select coalesce(string_agg(x.v, ', ' order by x.at), 'none')
  from (
    select distinct (a.details ->> 'shift_start')::timestamptz as at,
      case when (a.details ->> 'shift_start')::timestamptz < pg_temp.at('00:00') then 'yesterday ' else '' end
      || to_char((a.details ->> 'shift_start')::timestamptz at time zone 'America/Los_Angeles', 'HH24:MI') as v
    from public.alerts a
    where a.kind = 'late_clock_in' and a.user_id = '00000000-0000-4000-8000-0000000000c1'
  ) x
$$;

-- Last night's shift was 22:00-06:00; from today it's 09:00-17:00.
select pg_temp.shifts('22:00', '06:00', '09:00', '17:00');
select internal.alert_eval(pg_temp.at('02:00'));
select is(pg_temp.late(), 'yesterday 22:00',
  'at 02:00, last night''s 22:00 shift (the one that applied yesterday) is late');
select internal.alert_eval(pg_temp.at('10:00'));
select is(pg_temp.late(), 'yesterday 22:00, 09:00',
  'at 10:00, today''s current 09:00 shift is late too');

-- The other way round: last night had no night shift, from today there is one.
select pg_temp.shifts('09:00', '17:00', '22:00', '06:00');
select internal.alert_eval(pg_temp.at('02:00'));
select is(pg_temp.late(), 'none',
  'at 02:00, no alert for a night shift that didn''t apply yesterday');
select internal.alert_eval(pg_temp.at('23:00'));
select is(pg_temp.late(), '22:00', 'at 23:00, today''s current 22:00 shift is late');

-- Edited today with the history the trigger writes (not hand-made): yesterday's version.
delete from public.alerts;
delete from public.shifts where user_id = :erin;
delete from public.shift_history where user_id = :erin;
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values (:org, :erin, '{1,2,3,4,5,6,7}', '22:00', '06:00', 'America/Los_Angeles');
update public.shift_history set valid_from = '-infinity' where user_id = :erin;
update public.shifts set start_time = '13:00', end_time = '15:00' where user_id = :erin;
select internal.alert_eval(pg_temp.at('02:00'));
select is(pg_temp.late(), 'yesterday 22:00',
  'a night shift edited this morning still alerts for last night''s occurrence');

select * from finish();
rollback;
