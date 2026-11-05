-- #329: shift history (SHF-01) and the one leave rule (LV-04). Editing a shift today leaves
-- earlier days as they were: Insights' attendance, the leave hours of Reports and the
-- timesheet, and late clock-ins synced afterwards all use the shift that applied that day.
-- Dates are relative to today in Los Angeles (Erin's zone): last week is the ISO week
-- before this one.
begin;
create extension if not exists pgtap with schema extensions;

select plan(23);

\set org '''00000000-0000-4000-8000-000000000001'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set nina '''00000000-0000-4000-8000-0000000000d9'''

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
select t.today, w.week_from, w.week_from + 6 as week_to
from (select (now() at time zone 'America/Los_Angeles')::date as today) t
cross join lateral (select date_trunc('week', t.today)::date - 7 as week_from) w;
grant select on d to authenticated;

-- Erin's attendance and leave last week, as Insights and Reports show them.
create function pg_temp.erin_week() returns text
language sql as $$
  select format('%s shift days, %s without a clock-in, %s s scheduled, %s s leave; report leave %s',
    p ->> 'shift_days', p ->> 'no_clock_in', p ->> 'scheduled_s', p ->> 'leave_s',
    (select r ->> 'leave_s'
     from jsonb_array_elements(public.report_rows((select week_from from d), (select week_to from d)) -> 'rows') r
     where r ->> 'user_id' = '00000000-0000-4000-8000-0000000000c1'))
  from jsonb_array_elements(
    public.insights((select week_from from d), (select week_to from d)) -> 'people') p
  where p ->> 'user_id' = '00000000-0000-4000-8000-0000000000c1'
$$;

-- History ----------------------------------------------------------------------------------

select is(
  (select format('%s %s', valid_from, coalesce(valid_to::text, 'open')) from public.shift_history where user_id = :erin),
  '-infinity open', 'a shift from before the history applies all along');

-- Last Wednesday is a holiday: Erin's eight shift hours are leave.
insert into public.holidays (org_id, day, name) select :org, week_from + 2, 'Midweek' from d;

select pg_temp.act_as(:max);
create temp table before as select pg_temp.erin_week() as v;
select is((select v from before),
  '4 shift days, 4 without a clock-in, 115200 s scheduled, 28800 s leave; report leave 28800',
  'last week: Monday to Friday 09:00-17:00, Wednesday off for the holiday');

-- Today Max moves her to weekend afternoons.
select lives_ok(
  $$ select public.set_shifts('00000000-0000-4000-8000-0000000000c1',
       '[{"days": [6, 7], "start": "13:00", "end": "15:00", "timezone": "America/Los_Angeles"}]') $$,
  'the manager edits the shift today');
select pg_temp.act_as_postgres();
select results_eq(
  $$ select valid_from, valid_to, days from public.shift_history
     where user_id = '00000000-0000-4000-8000-0000000000c1' order by valid_from $$,
  $$ select '-infinity'::date, today, array[1, 2, 3, 4, 5] from d
     union all select today, null::date, array[6, 7] from d $$,
  'the old shift applied up to yesterday, the new one from today');
select is((select count(*)::int from public.shifts where user_id = :erin), 1,
  'public.shifts holds only the current one');

select pg_temp.act_as(:max);
select is(pg_temp.erin_week(), (select v from before),
  'last week''s Insights and Reports numbers are unchanged');
select pg_temp.act_as_postgres();

select is(
  (select count(*)::int from d, internal.shift_occurrences(array[:erin]::uuid[], d.week_from, d.week_to) o),
  5, 'last week''s occurrences are the old shift''s');
select is(
  (select string_agg(extract(isodow from o.day)::text || ' ' || to_char(o.starts_at at time zone 'America/Los_Angeles', 'HH24:MI'), ', ' order by o.day)
   from d, internal.shift_occurrences(array[:erin]::uuid[], d.today, d.today + 6) o),
  '6 13:00, 7 13:00', 'from today, the new one''s');
select is(
  (select seconds::int from d, internal.leave_days(array[:erin]::uuid[], d.week_from, d.week_to) l),
  28800, 'the timesheet''s Leave row keeps last week''s holiday at the old shift''s hours');

-- A second edit the same day replaces today's version: it never applied to a whole day.
select pg_temp.act_as(:max);
select lives_ok(
  $$ select public.set_shifts('00000000-0000-4000-8000-0000000000c1',
       '[{"days": [6], "start": "14:00", "end": "16:00", "timezone": "America/Los_Angeles"}]') $$,
  'a second edit today');
select pg_temp.act_as_postgres();
select results_eq(
  $$ select valid_from, valid_to, days from public.shift_history
     where user_id = '00000000-0000-4000-8000-0000000000c1' order by valid_from $$,
  $$ select '-infinity'::date, today, array[1, 2, 3, 4, 5] from d
     union all select today, null::date, array[6] from d $$,
  'only the latest of the day is kept');

-- Late clock-ins (SHF-06): a session from last Tuesday synced today is checked against the
-- shift of that day.
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000e1', :org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-history');
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
select :org, :erin, '00000000-0000-4000-8000-0000000000e1',
  (week_from + 1 + time '09:30')::timestamp at time zone 'America/Los_Angeles',
  (week_from + 1 + time '17:00')::timestamp at time zone 'America/Los_Angeles', gen_random_uuid()
from d;
select is(
  (select format('%s %s', l.day = d.week_from + 1, l.late_s) from public.late_clock_ins l, d where l.user_id = :erin),
  't 1800', 'late against last week''s 09:00 shift, though today''s is on weekends');

-- A first shift applies from today: nothing before it changes.
insert into auth.users (id, email) values (:nina, 'nina@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id, timezone)
values (:nina, :org, 'Nina New', 'nina@acme.test', 'employee', :max, 'America/Los_Angeles');
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values (:org, :nina, '{1,2,3,4,5,6,7}', '09:00', '17:00', 'America/Los_Angeles');
select is(
  (select count(*)::int from d, internal.shift_occurrences(array[:nina]::uuid[], d.week_from, d.week_to) o),
  0, 'a new person''s first shift has no occurrences last week');
select is(
  (select count(*)::int from d, internal.shift_occurrences(array[:nina]::uuid[], d.today, d.today) o),
  1, 'and has one today');
delete from public.users where id = :nina;
select is((select count(*)::int from public.shift_history where user_id = :nina), 0,
  'deleting the person deletes their history');

-- One leave rule (LV-04) ---------------------------------------------------------------------

insert into public.leave_requests (org_id, user_id, leave_type_id, paid, kind, first_day, last_day,
  start_at, end_at, timezone, status)
select :org, :erin, t.id, true, 'part_day', d.today + 7, d.today + 7,
  (d.today + 7 + time '13:00')::timestamp at time zone 'America/Los_Angeles',
  (d.today + 7 + time '15:00')::timestamp at time zone 'America/Los_Angeles',
  'America/Los_Angeles', 'approved'
from public.leave_types t, d where t.org_id = :org and t.name = 'Vacation';

select is(internal.on_leave_at(:erin,
    (select (today + 7 + time '13:00')::timestamp at time zone 'America/Los_Angeles' from d)), true,
  'on leave from the start of an approved request');
select is(internal.on_leave_at(:erin,
    (select (today + 7 + time '15:00')::timestamp at time zone 'America/Los_Angeles' from d)), false,
  'and not at its end');
select is(internal.on_leave_at(:erin,
    (select (week_from + 2 + time '23:59')::timestamp at time zone 'America/Los_Angeles' from d)), true,
  'a holiday is the whole local day');
select is(internal.on_leave_at(:erin,
    (select (week_from + 3)::timestamp at time zone 'America/Los_Angeles' from d)), false,
  'and ends at midnight');
select is(
  (select count(*)::int from d, internal.leave_periods(array[:erin]::uuid[],
     (d.week_from)::timestamp at time zone 'UTC', (d.today + 8)::timestamp at time zone 'UTC')),
  2, 'leave_periods: the holiday and the request');
select is(
  (select jsonb_array_length(internal.leave_spans(:erin,
     (select week_from::timestamp at time zone 'America/Los_Angeles' from d)))),
  2, 'the agent''s leave spans read the same periods');

-- Retention: a shift that stopped applying before the timesheet window goes; current ones stay.
insert into public.shift_history (org_id, user_id, shift_id, days, start_time, end_time, timezone, valid_from, valid_to)
values (:org, :erin, gen_random_uuid(), '{1}', '09:00', '10:00', 'UTC', '2001-01-01', '2002-01-01');
select ok((public.retention_purge_rows() ->> 'shift_history')::int >= 1, 'retention purges old shift history');
select is((select count(*)::int from public.shift_history where user_id = :erin and valid_to is null), 1,
  'and keeps the current shift');

select * from finish();
rollback;
