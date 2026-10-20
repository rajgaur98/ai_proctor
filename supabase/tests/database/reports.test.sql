begin;
create extension if not exists pgtap with schema extensions;

select plan(48);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set mia '''00000000-0000-4000-8000-0000000000d1'''
\set ivan '''00000000-0000-4000-8000-0000000000d2'''
\set zed '''00000000-0000-4000-8000-0000000000d3'''
\set org '''00000000-0000-4000-8000-000000000001'''

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

-- The week's report rows, as a json array; the filters default to none.
create function pg_temp.rows(
  p_from date default '2026-03-16', p_to date default '2026-03-22',
  p_user_ids uuid[] default null, p_manager_id uuid default null
) returns jsonb
language sql as $$
  select public.report_rows(p_from, p_to, p_user_ids, p_manager_id) -> 'rows'
$$;

-- One metric of one person in the week's report, as text.
create function pg_temp.metric(uid uuid, key text, p_from date default '2026-03-16', p_to date default '2026-03-22')
returns text
language sql as $$
  select r ->> key from jsonb_array_elements(pg_temp.rows(p_from, p_to, array[uid]::uuid[])) r
$$;

-- The names in a report, in order.
create function pg_temp.names(rows jsonb) returns text
language sql as $$
  select coalesce(string_agg(r ->> 'full_name', ', ' order by ord), '')
  from jsonb_array_elements(rows) with ordinality as t (r, ord)
$$;

-- Mia manages nobody involved. Ivan was deactivated but has time in the week; Zed was
-- deactivated and has none (ORG-07: deactivated users keep their data).
insert into auth.users (id, email) values
  (:mia, 'mia@acme.test'), (:ivan, 'ivan@acme.test'), (:zed, 'zed@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id, active, timezone)
values
  (:mia, :org, 'Mia Manager', 'mia@acme.test', 'manager', :ada, true, 'UTC'),
  (:ivan, :org, 'Ivan Inactive', 'ivan@acme.test', 'employee', :max, false, 'UTC'),
  (:zed, :org, 'Zed Inactive', 'zed@acme.test', 'employee', :max, false, 'UTC');

-- Erin is in America/Los_Angeles (-07 from March 8 2026), Lucas in America/Chicago (-05).
-- Erin, Monday 16th: verified 09:00-11:00, idle 11:00-11:20 (flagged), unverified
-- 11:20-11:45 (flagged, excluded by a manager), break 11:45-12:00, verified 12:00-13:00,
-- manual 13:00-14:00, pause 14:00-14:10 (within the cap), pause over the cap 14:10-14:15
-- (flagged, not counted). Tuesday: verified 09:00-10:00.
-- Worked 16200 + 3600, flagged 1500, excluded 1500, break 900, pause 900, manual 3600.
-- Lucas, Monday: verified 09:00-10:00, break 10:00-10:30; and an hour on the 23rd (outside).
insert into public.time_segments
  (org_id, user_id, day, start_at, end_at, type, project_id, counted, flagged, excluded)
values
  (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 11:00:00-07', 'verified', null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07', 'idle', null, true, true, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07', 'unverified', null, true, true, true),
  (:org, :erin, '2026-03-16', '2026-03-16 11:45:00-07', '2026-03-16 12:00:00-07', 'break', null, false, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 12:00:00-07', '2026-03-16 13:00:00-07', 'verified', null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 13:00:00-07', '2026-03-16 14:00:00-07', 'manual', null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 14:00:00-07', '2026-03-16 14:10:00-07', 'pause', null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 14:10:00-07', '2026-03-16 14:15:00-07', 'pause_over_cap', null, false, true, false),
  (:org, :erin, '2026-03-17', '2026-03-17 09:00:00-07', '2026-03-17 10:00:00-07', 'verified', null, true, false, false),
  (:org, :lucas, '2026-03-16', '2026-03-16 09:00:00-05', '2026-03-16 10:00:00-05', 'verified', null, true, false, false),
  (:org, :lucas, '2026-03-16', '2026-03-16 10:00:00-05', '2026-03-16 10:30:00-05', 'break', null, false, false, false),
  (:org, :lucas, '2026-03-23', '2026-03-23 09:00:00-05', '2026-03-23 10:00:00-05', 'verified', null, true, false, false),
  (:org, :ivan, '2026-03-18', '2026-03-18 09:00:00+00', '2026-03-18 12:00:00+00', 'verified', null, true, false, false);

insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000e1', :org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-reports'),
       ('00000000-0000-4000-8000-0000000000e2', :org, :lucas, 'macos', '26.0', '0.1.0', 'hash-lucas-reports');

-- Erin's check-ins in the week: five passes (responses 1000, 2000, 4000, 9000 ms, and one
-- scheduled 17th 08:00 and never shown, with no response time), two misses and a failed
-- one. Outside the week by her local day: a miss at 23:59:50 on the 15th (already the
-- 16th in UTC) and a miss 30 s into the 23rd.
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome, response_ms)
values
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 10:00:00-07', '2026-03-16 10:00:02-07', 'pass', 1000),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 10:30:00-07', '2026-03-16 10:30:02-07', 'pass', 2000),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 12:30:00-07', '2026-03-16 12:30:02-07', 'pass', 4000),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 13:30:00-07', '2026-03-16 13:30:02-07', 'pass', 9000),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-17 08:00:00-07', null, 'pass', null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 11:00:00-07', '2026-03-16 11:00:03-07', 'miss', null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-17 09:30:00-07', '2026-03-17 09:30:03-07', 'miss', null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-17 09:45:00-07', '2026-03-17 09:45:03-07', 'failed', 800),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-15 23:59:50-07', '2026-03-15 23:59:52-07', 'miss', null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-23 00:00:30-07', '2026-03-23 00:00:32-07', 'pass', 500),
  -- Lucas: two quick passes.
  (gen_random_uuid(), :org, :lucas, '00000000-0000-4000-8000-0000000000e2', '2026-03-16 09:30:00-05', '2026-03-16 09:30:02-05', 'pass', 100),
  (gen_random_uuid(), :org, :lucas, '00000000-0000-4000-8000-0000000000e2', '2026-03-16 09:45:00-05', '2026-03-16 09:45:02-05', 'pass', 200);

-- Late clock-ins. Erin's shifts: Monday to Friday 09:00-17:00 Los Angeles time (the seed
-- ones are replaced). Monday she clocks in at 09:20 (late; an earlier session that ended
-- before the shift doesn't help), Tuesday 09:10 (on time), Wednesday exactly 09:15 (not
-- more than 15 minutes), Thursday at 08:30 and is still clocked in when the shift
-- starts, Friday not at all (a no-show is not a late clock-in).
-- Lucas works a Monday night shift 22:00-06:00 and clocks in at 22:30 (late).
delete from public.shifts;
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values
  (:org, :erin, '{1,2,3,4,5}', '09:00', '17:00', 'America/Los_Angeles'),
  (:org, :lucas, '{1}', '22:00', '06:00', 'America/Chicago');
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
values
  (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 07:00:00-07', '2026-03-16 08:00:00-07', gen_random_uuid()),
  (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 09:20:00-07', '2026-03-16 17:00:00-07', gen_random_uuid()),
  (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-17 09:10:00-07', '2026-03-17 17:00:00-07', gen_random_uuid()),
  (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-18 09:15:00-07', '2026-03-18 17:00:00-07', gen_random_uuid()),
  (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-19 08:30:00-07', '2026-03-19 17:00:00-07', gen_random_uuid()),
  (:org, :lucas, '00000000-0000-4000-8000-0000000000e2', '2026-03-16 22:30:00-05', '2026-03-17 06:00:00-05', gen_random_uuid());

-- Who sees what --------------------------------------------------------------------------------

select pg_temp.act_as(:ada);
select is(pg_temp.names(pg_temp.rows()), 'Erin Employee, Ivan Inactive, Lucas Martin, Max Manager, Mia Manager',
  'the owner sees everyone but themselves, by name; a deactivated person without data is out');

select pg_temp.act_as(:max);
select is(pg_temp.names(pg_temp.rows()), 'Erin Employee, Ivan Inactive, Lucas Martin',
  'a manager sees their reports, not themselves');
select is(pg_temp.names(pg_temp.rows(p_user_ids => array[:max]::uuid[])), 'Max Manager',
  'a person may name themselves');
select is(pg_temp.names(pg_temp.rows(p_user_ids => array[:erin]::uuid[])), 'Erin Employee', 'filter: one employee');
select is(pg_temp.names(pg_temp.rows(p_manager_id => :max)), 'Erin Employee, Ivan Inactive, Lucas Martin',
  'filter: the manager''s direct reports (the team filter until ORG-08)');
select is(pg_temp.names(pg_temp.rows(p_manager_id => :mia)), '', 'filter: another manager''s team is none of these');
select is(pg_temp.names(pg_temp.rows(p_user_ids => '{}')), 'Erin Employee, Ivan Inactive, Lucas Martin',
  'filter: an empty list means no filter');
select throws_ok(format($$ select pg_temp.rows(p_user_ids => array[%L]::uuid[]) $$, :ada),
  '42501', 'forbidden', 'a manager cannot name their own manager');

select pg_temp.act_as(:mia);
select is(pg_temp.names(pg_temp.rows()), '', 'a manager of nobody involved sees none of it');
select throws_ok(format($$ select pg_temp.rows(p_user_ids => array[%L]::uuid[]) $$, :erin),
  '42501', 'forbidden', 'nor can they name Erin');

select pg_temp.act_as(:erin);
select is(pg_temp.names(pg_temp.rows()), '', 'an employee has no team');
select is(pg_temp.names(pg_temp.rows(p_user_ids => array[:erin]::uuid[])), 'Erin Employee', 'but gets their own numbers');
select throws_ok(format($$ select pg_temp.rows(p_user_ids => array[%L]::uuid[]) $$, :lucas),
  '42501', 'forbidden', 'and cannot name a peer');
select throws_ok(format($$ select pg_temp.rows(p_user_ids => array[%L, %L]::uuid[]) $$, :erin, :lucas),
  '42501', 'forbidden', 'one name that may not be viewed refuses the whole report');

-- An active delegate sees the manager's reports.
select pg_temp.act_as_postgres();
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org, :max, :mia, current_date, current_date + 3);
select pg_temp.act_as(:mia);
select is(pg_temp.names(pg_temp.rows()), 'Erin Employee, Ivan Inactive, Lucas Martin',
  'an active delegate sees the manager''s reports');

-- Time ------------------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select is(pg_temp.metric(:erin, 'worked_s'), '19800', 'worked: counted and not excluded');
select is(pg_temp.metric(:erin, 'flagged_s'), '1500', 'flagged: flagged and not excluded (idle and the pause over the cap)');
select is(pg_temp.metric(:erin, 'excluded_s'), '1500', 'excluded: what a manager excluded');
select is(pg_temp.metric(:erin, 'break_s'), '900', 'break total');
select is(pg_temp.metric(:erin, 'pause_s'), '900', 'pause total: within the cap and over it');
select is(pg_temp.metric(:erin, 'manual_s'), '3600', 'manual time that is worked');
select is(pg_temp.metric(:lucas, 'worked_s') || '/' || pg_temp.metric(:lucas, 'break_s'), '3600/1800',
  'another person''s time is their own; the 23rd is outside the week');
select is(pg_temp.metric(:erin, 'worked_s', '2026-03-17', '2026-03-17'), '3600', 'a single day');
select is(pg_temp.metric(:erin, 'worked_s', '2026-03-16', '2026-03-17'), '19800', 'a range of two days');
select is(pg_temp.metric(:ivan, 'worked_s'), '10800', 'a deactivated person''s time stays in');
select is(pg_temp.metric(:lucas, 'flagged_s') || '/' || pg_temp.metric(:lucas, 'pause_s'), '0/0', 'no time is zero, not null');

-- The numbers equal the timesheet totals for the same week.
select is(
  (select jsonb_agg(jsonb_build_array(r ->> 'user_id', r -> 'worked_s', r -> 'flagged_s', r -> 'excluded_s')
                    order by r ->> 'user_id')
   from jsonb_array_elements(pg_temp.rows()) r),
  (select jsonb_agg(jsonb_build_array(t.user_id::text, t.worked_s, t.flagged_s, t.excluded_s) order by t.user_id::text)
   from public.timesheet_totals('2026-03-16', '2026-03-22') t
   where t.user_id in (:erin, :lucas, :ivan)),
  'worked, flagged and excluded equal timesheet_totals for the same week');

-- Check-ins --------------------------------------------------------------------------------------

select is(pg_temp.metric(:erin, 'checkins_shown'), '8', 'shown: every outcome in the week by local day (the 15th and the 23rd are out)');
select is(pg_temp.metric(:erin, 'checkins_passed'), '5', 'passed');
select is(pg_temp.metric(:erin, 'checkins_missed'), '2', 'missed');
select is(pg_temp.metric(:erin, 'checkins_failed'), '1', 'failed');
select is(pg_temp.metric(:erin, 'response_rate'), '0.625', 'response rate is passed / shown, unrounded');
select is(pg_temp.metric(:erin, 'median_response_ms'), '3000',
  'median response time of the passes that have one (1000, 2000, 4000, 9000)');
select is(pg_temp.metric(:lucas, 'checkins_shown') || '/' || pg_temp.metric(:lucas, 'response_rate')
          || '/' || pg_temp.metric(:lucas, 'median_response_ms'), '2/1/150',
  'a person with only passes: rate 1, median of their two (interpolated)');
select is(pg_temp.metric(:ivan, 'checkins_shown') || '/' || coalesce(pg_temp.metric(:ivan, 'response_rate'), 'null')
          || '/' || coalesce(pg_temp.metric(:ivan, 'median_response_ms'), 'null'), '0/null/null',
  'no check-ins: no rate and no median');
select is((public.report_rows('2026-03-16', '2026-03-22') ->> 'team_median_response_ms'), '1500',
  'team median: over all the passes together (100, 200, 1000, 2000, 4000, 9000), not of the medians');
select is((public.report_rows('2026-03-18', '2026-03-22') -> 'team_median_response_ms'), 'null'::jsonb,
  'team median: null without passes');
select is(pg_temp.metric(:erin, 'checkins_shown', '2026-03-15', '2026-03-15'), '1', 'a single day, by the employee''s local day');

-- Late clock-ins ---------------------------------------------------------------------------------

select is(pg_temp.metric(:erin, 'late_clock_ins'), '1',
  'late: only Monday''s 09:20 (09:15 exactly, 09:10, early and never are not)');
select is(pg_temp.metric(:lucas, 'late_clock_ins'), '1', 'late: a night shift crossing midnight, clocked in 22:30');
select is(pg_temp.metric(:erin, 'late_clock_ins', '2026-03-17', '2026-03-22'), '0', 'late: only occurrences in the range count');
select is((public.report_rows('2026-03-16', '2026-03-22') ->> 'late_grace_min'), '15', 'the default grace is 15 minutes');

select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"late_clock_in_min": 30}' where id = :org;
select pg_temp.act_as(:max);
select is(pg_temp.metric(:erin, 'late_clock_ins') || '/' || pg_temp.metric(:lucas, 'late_clock_ins'), '0/0',
  'policy: a 30 minute grace makes 09:20 and 22:30 (exactly 30) on time');
select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"late_clock_in_min": 1}' where id = :org;
select pg_temp.act_as(:max);
select is(pg_temp.metric(:erin, 'late_clock_ins'), '3', 'policy: a grace below 5 minutes counts as 5 (Mon 09:20, Tue 09:10, Wed 09:15)');
select is((public.report_rows('2026-03-16', '2026-03-22') ->> 'late_grace_min'), '5', 'and says so');

-- Invalid requests ---------------------------------------------------------------------------------

select throws_ok($$ select pg_temp.rows('2026-03-22', '2026-03-16') $$, '22023', 'invalid_range', 'a range that ends before it starts is refused');
select throws_ok($$ select pg_temp.rows('2025-01-01', '2026-03-16') $$, '22023', 'invalid_range', 'more than a year is refused');

-- Permissions --------------------------------------------------------------------------------------

select set_config('role', 'anon', true);
select throws_ok($$ select public.report_rows('2026-03-16', '2026-03-22') $$, '42501', null, 'anon cannot call it');

select * from finish();
rollback;
