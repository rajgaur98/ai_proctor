-- #319: leave on timesheets (LV-05), in the timesheet export and Reports (LV-06), and the
-- time-off list's team filter. Week of Mon 23 Nov 2026 (Thanksgiving Thu 26).
begin;
create extension if not exists pgtap with schema extensions;

select plan(32);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''

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

-- An approved request for a person, straight into the table (the rules are time_off's tests).
create function pg_temp.leave(uid uuid, p_type text, p_kind text, p_first date, p_last date,
  p_start timestamptz, p_end timestamptz, p_status text default 'approved')
returns uuid language sql as $$
  insert into public.leave_requests (org_id, user_id, leave_type_id, paid, kind, first_day,
    last_day, start_at, end_at, timezone, status)
  select '00000000-0000-4000-8000-000000000001', uid, t.id, t.paid, p_kind, p_first, p_last,
    p_start, p_end, 'America/Los_Angeles', p_status
  from public.leave_types t
  where t.org_id = '00000000-0000-4000-8000-000000000001' and t.name = p_type
  returning id
$$;

-- Erin (LA, Mon-Fri 9-17): Vacation Mon-Tue, a part day Wed 13:00-15:30 (Sick), Thanksgiving
-- on Thu (everyone) with a part day on it too, Unpaid on Fri, and a pending request on Sat.
select pg_temp.leave(:erin, 'Vacation', 'days', '2026-11-23', '2026-11-24',
  '2026-11-23 00:00 America/Los_Angeles', '2026-11-25 00:00 America/Los_Angeles');
select pg_temp.leave(:erin, 'Sick', 'part_day', '2026-11-25', '2026-11-25',
  '2026-11-25 13:00 America/Los_Angeles', '2026-11-25 15:30 America/Los_Angeles');
select pg_temp.leave(:erin, 'Personal', 'part_day', '2026-11-26', '2026-11-26',
  '2026-11-26 16:00 America/Los_Angeles', '2026-11-26 18:00 America/Los_Angeles');
select pg_temp.leave(:erin, 'Unpaid', 'days', '2026-11-27', '2026-11-27',
  '2026-11-27 00:00 America/Los_Angeles', '2026-11-28 00:00 America/Los_Angeles');
select pg_temp.leave(:erin, 'Vacation', 'days', '2026-11-28', '2026-11-28',
  '2026-11-28 00:00 America/Los_Angeles', '2026-11-29 00:00 America/Los_Angeles', 'pending');
insert into public.holidays (org_id, day, name) values (:org, '2026-11-26', 'Thanksgiving');

-- leave_days ------------------------------------------------------------------------------

create temp table erin_leave as
  select * from internal.leave_days(array[:erin]::uuid[], '2026-11-23', '2026-11-29');

select is((select seconds from erin_leave where day = '2026-11-23'), 28800::bigint,
  'whole-day paid leave counts the shift''s hours');
select is((select items from erin_leave where day = '2026-11-23'),
  '[{"name": "Vacation", "paid": true, "holiday": false, "part_day": false}]'::jsonb,
  'and says what it is');
select is((select seconds from erin_leave where day = '2026-11-24'), 28800::bigint,
  'every day of it');
select is((select seconds from erin_leave where day = '2026-11-25'), 9000::bigint,
  'a part day counts its span');
select is((select seconds from erin_leave where day = '2026-11-26'), 28800::bigint + 3600,
  'a holiday counts the shift; a part day on it counts only its time outside the shift');
select is((select jsonb_array_length(items) from erin_leave where day = '2026-11-26'), 2,
  'both are named on the day');
select is((select items -> 0 ->> 'name' from erin_leave where day = '2026-11-26'), 'Thanksgiving',
  'the holiday first');
select is((select seconds from erin_leave where day = '2026-11-27'), 0::bigint,
  'unpaid leave counts 0');
select is((select items -> 0 ->> 'paid' from erin_leave where day = '2026-11-27'), 'false',
  'but is listed as unpaid');
select ok(not exists (select 1 from erin_leave where day in ('2026-11-28', '2026-11-29')),
  'a pending request is not leave, and a day without any has no row');

-- Lucas (Chicago, Mon-Thu 22:00-06:00): Thanksgiving covers the start of Wed's night shift's
-- next morning and the evening of Thu's.
select is(
  (select array_agg(seconds order by day) from internal.leave_days(array[:lucas]::uuid[], '2026-11-23', '2026-11-29')),
  array[21600, 7200]::bigint[],
  'night shifts: the hours of each shift inside the holiday, on the day the shift starts');

-- No shift that day: whole-day leave counts nothing, but still shows.
select pg_temp.leave(:erin, 'Vacation', 'days', '2026-12-05', '2026-12-05',
  '2026-12-05 00:00 America/Los_Angeles', '2026-12-06 00:00 America/Los_Angeles');
select is(
  (select seconds from internal.leave_days(array[:erin]::uuid[], '2026-12-05', '2026-12-05')),
  0::bigint, 'paid leave on a day without a shift counts 0');

-- timesheet_leave -----------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is((select sum(seconds) from public.timesheet_leave('2026-11-23', '2026-11-29', :erin)),
  (28800 * 3 + 9000 + 3600)::numeric, 'Erin reads her own week''s leave');
select is((select count(*)::int from public.timesheet_leave('2026-11-23', '2026-11-29', :lucas)), 0,
  'not a peer''s');
select is((select count(distinct user_id)::int from public.timesheet_leave('2026-11-23', '2026-11-29')), 1,
  'everyone she can see is only her');
select throws_ok($$ select * from public.timesheet_leave('2026-11-29', '2026-11-23') $$,
  '22023', 'invalid_range', 'a backwards range is refused');

select pg_temp.act_as(:max);
select is((select count(distinct user_id)::int from public.timesheet_leave('2026-11-23', '2026-11-29')), 3,
  'the manager reads both reports and himself (the holiday, with no shift to count)');
select is((select seconds from public.timesheet_leave('2026-11-23', '2026-11-29', :erin) where day = '2026-11-25'),
  9000::bigint, 'and one of them by id');

-- Worked time is untouched: no segments, no worked time.
select is((select count(*)::int from public.timesheet_totals('2026-11-23', '2026-11-29')
           where worked_s > 0), 0, 'leave is never worked time');

-- report_rows ----------------------------------------------------------------------------------

select is(
  (select (r ->> 'leave_s')::bigint
   from jsonb_array_elements(public.report_rows('2026-11-23', '2026-11-29') -> 'rows') r
   where r ->> 'user_id' = :erin),
  (28800 * 3 + 9000 + 3600)::bigint, 'Reports: Erin''s leave_s');
select is(
  (select (r ->> 'worked_s')::bigint
   from jsonb_array_elements(public.report_rows('2026-11-23', '2026-11-29') -> 'rows') r
   where r ->> 'user_id' = :erin),
  0::bigint, 'apart from her worked time');
select is(
  (select (r ->> 'leave_s')::bigint
   from jsonb_array_elements(public.report_rows('2026-11-23', '2026-11-29') -> 'rows') r
   where r ->> 'user_id' = :lucas),
  28800::bigint, 'Lucas''s leave_s');

-- timesheet_export_rows --------------------------------------------------------------------------

create temp table export_leave as
  select public.timesheet_export_rows('2026-11-23', '2026-11-29', 'daily', array[:erin]::uuid[]) as r;
grant select on export_leave to authenticated;
select is((select jsonb_array_length(r -> 'leave') from export_leave), 5,
  'the export carries Erin''s leave days');
select is(
  (select l -> 'seconds' from export_leave, jsonb_array_elements(r -> 'leave') l
   where l ->> 'day' = '2026-11-26'), '32400'::jsonb, 'with their seconds');
select is(
  (select l ->> 'employee' || ' ' || (l ->> 'status') from export_leave, jsonb_array_elements(r -> 'leave') l
   where l ->> 'day' = '2026-11-23'), 'Erin Employee draft', 'who and the week''s status');
select is(
  (select jsonb_array_length(public.timesheet_export_rows('2026-11-23', '2026-11-29', 'daily',
     array[:erin]::uuid[], null, null, array[:revamp]::uuid[]) -> 'leave')),
  0, 'a project filter leaves leave out: it is on no project');
select is(
  (select jsonb_array_length(public.timesheet_export_rows('2026-11-23', '2026-11-29', 'daily',
     array[:erin]::uuid[], null, null, null, array['approved']) -> 'leave')),
  0, 'a status filter applies to the leave day''s week');
select is(
  (select jsonb_array_length(public.timesheet_export_rows('2026-11-23', '2026-11-29', 'daily',
     null, :max) -> 'leave')),
  7, 'the manager''s team: both reports'' leave days');

select pg_temp.act_as(:lucas);
select is(
  (select jsonb_array_length(public.timesheet_export_rows('2026-11-23', '2026-11-29', 'daily') -> 'leave')),
  2, 'an employee''s export holds only their own leave');

select pg_temp.act_as_postgres();
select is(
  (select metadata -> 'leave_days' from public.audit_log
   where action = 'timesheet.exported' and actor_id = :lucas order by id desc limit 1),
  '2'::jsonb, 'the audit row counts the leave days exported');

-- leave_requests_list: team filter ---------------------------------------------------------------

insert into public.teams (id, org_id, name)
values ('00000000-0000-4000-8000-0000000319a1', :org, 'Leave test team');
update public.users set team_id = '00000000-0000-4000-8000-0000000319a1' where id = :lucas;
select pg_temp.leave(:lucas, 'Vacation', 'days', '2026-11-30', '2026-11-30',
  '2026-11-30 00:00 America/Chicago', '2026-12-01 00:00 America/Chicago');

select pg_temp.act_as(:max);
select is(
  (select array_agg(distinct user_id) from public.leave_requests_list(
     p_team_id => '00000000-0000-4000-8000-0000000319a1')),
  array[:lucas]::uuid[], 'the team filter keeps its members'' requests');
select is(
  (select count(*)::int from public.leave_requests_list(
     p_from => '2026-11-23', p_to => '2026-11-29', p_user_id => :erin, p_status => 'pending')),
  1, 'person, dates and status still filter');

select * from finish();
rollback;
