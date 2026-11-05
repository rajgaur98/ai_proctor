-- #305: Insights (INS-01..06). The numbers equal the Reports tab's (report_rows and
-- report_task_rows) for the same filters, the trends compare with the previous range of
-- the same length, attendance leaves out leave and holidays, and the weekly email adds
-- up the same numbers. Dates are fixed in March 2026 (the seed people's zones).
begin;
create extension if not exists pgtap with schema extensions;

select plan(99);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set mia '''00000000-0000-4000-8000-0000000000d1'''
\set ivan '''00000000-0000-4000-8000-0000000000d2'''
\set zed '''00000000-0000-4000-8000-0000000000d3'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''
\set internal '''00000000-0000-4000-8000-0000000000f2'''
\set task '''00000000-0000-4000-8000-0000000000f3'''
\set team '''00000000-0000-4000-8000-0000000000f4'''

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

create function pg_temp.ins(
  p_from date default '2026-03-16', p_to date default '2026-03-22',
  p_team uuid default null, p_ids uuid[] default null
) returns jsonb
language sql as $$ select public.insights(p_from, p_to, p_team, p_ids) $$;

-- One number of one person's row, as text.
create function pg_temp.person(uid uuid, key text, p_ids uuid[] default null) returns text
language sql as $$
  select r ->> key from jsonb_array_elements(pg_temp.ins(p_ids => p_ids) -> 'people') r
  where r ->> 'user_id' = uid::text
$$;

create function pg_temp.names(j jsonb) returns text
language sql as $$
  select coalesce(string_agg(r ->> 'full_name', ', ' order by ord), '')
  from jsonb_array_elements(j -> 'people') with ordinality as t (r, ord)
$$;

-- Every difference between a person's insights row and their report row, for the same
-- filters ('' when they agree), and between the insights totals and the report's rows
-- added up the way the Reports tab adds them (teamTotals).
create function pg_temp.mismatches(
  p_from date, p_to date, p_team uuid default null, p_ids uuid[] default null
) returns text
language sql as $$
  with r as (select public.report_rows(p_from, p_to, p_ids, null, p_team) as j),
  i as (select public.insights(p_from, p_to, p_team, p_ids) as j),
  rr as (select x from r, jsonb_array_elements(r.j -> 'rows') x),
  ii as (select x from i, jsonb_array_elements(i.j -> 'people') x),
  keys (k) as (values ('full_name'), ('worked_s'), ('flagged_s'), ('excluded_s'), ('break_s'),
    ('pause_s'), ('manual_s'), ('checkins_shown'), ('checkins_passed'), ('checkins_missed'),
    ('checkins_failed'), ('response_rate'), ('median_response_ms'), ('late_clock_ins'),
    ('anomaly_flags'), ('needs_review'), ('leave_s')),
  people as (
    select format('%s.%s: report %s, insights %s',
      coalesce(rr.x ->> 'full_name', ii.x ->> 'full_name'), keys.k, rr.x -> keys.k, ii.x -> keys.k) as m
    from rr full join ii on rr.x ->> 'user_id' = ii.x ->> 'user_id'
    cross join keys
    where (rr.x -> keys.k) is distinct from (ii.x -> keys.k)
  ),
  sums as (
    select format('total.%s: report %s, insights %s', k, a, b) as m
    from r, i, lateral (values
      ('people', (r.j -> 'row_count'), (i.j -> 'totals' -> 'people')),
      ('median_response_ms', (r.j -> 'team_median_response_ms'), (i.j -> 'totals' -> 'median_response_ms'))
    ) v (k, a, b)
    where a is distinct from b
    union all
    select format('total.%s: report %s, insights %s', k.k, s.v, i.j -> 'totals' -> k.k)
    from i, keys k
    cross join lateral (
      select to_jsonb(sum((x ->> k.k)::numeric)) as v from rr
    ) s
    where k.k not in ('full_name', 'response_rate', 'median_response_ms')
      and coalesce(s.v, '0'::jsonb) is distinct from i.j -> 'totals' -> k.k
  )
  select coalesce(string_agg(m, '; ' order by m), '') from (
    select m from people union all select m from sums
  ) x
$$;

-- Worked seconds per project and task, from report_task_rows and from insights.
create function pg_temp.project_mismatches(p_from date, p_to date) returns text
language sql as $$
  with a as (
    select project_id, task_id, sum(worked_s) as w
    from public.report_task_rows(p_from, p_to) group by 1, 2
  ),
  b as (
    select (x ->> 'project_id')::uuid as project_id, (x ->> 'task_id')::uuid as task_id,
      (x ->> 'worked_s')::bigint as w
    from jsonb_array_elements(public.insights(p_from, p_to) -> 'projects') x
  )
  select coalesce(string_agg(format('%s/%s: %s vs %s', coalesce(a.project_id, b.project_id),
    coalesce(a.task_id, b.task_id), a.w, b.w), '; '), '')
  from a full join b
    on coalesce(a.project_id, '00000000-0000-0000-0000-000000000000') = coalesce(b.project_id, '00000000-0000-0000-0000-000000000000')
    and coalesce(a.task_id, '00000000-0000-0000-0000-000000000000') = coalesce(b.task_id, '00000000-0000-0000-0000-000000000000')
  where coalesce(a.w, 0) <> coalesce(b.w, 0)
$$;

-- People ------------------------------------------------------------------------------------------
-- Mia manages nobody involved. Ivan was deactivated but has time in the week; Zed was
-- deactivated and has none. Erin is in a team with a 60% billable target.
insert into auth.users (id, email) values
  (:mia, 'mia@acme.test'), (:ivan, 'ivan@acme.test'), (:zed, 'zed@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id, active, timezone)
values
  (:mia, :org, 'Mia Manager', 'mia@acme.test', 'manager', :ada, true, 'UTC'),
  (:ivan, :org, 'Ivan Inactive', 'ivan@acme.test', 'employee', :max, false, 'UTC'),
  (:zed, :org, 'Zed Inactive', 'zed@acme.test', 'employee', :max, false, 'UTC');
insert into public.teams (id, org_id, name, billable_target_pct) values (:team, :org, 'Web', 60);
update public.users set team_id = :team where id = :erin;
insert into public.project_tasks (id, org_id, project_id, name, billable)
values (:task, :org, :revamp, 'Design', false);

-- Time. Erin (Los Angeles, -07), Monday 16th: verified 09:00-11:00 on Website revamp
-- (billable), idle 11:00-11:20 (flagged), unverified 11:20-11:45 (flagged, excluded),
-- break 11:45-12:00, verified 12:00-13:00 on Internal, manual 13:00-14:00, pause
-- 14:00-14:10 and over the cap 14:10-14:15. Tuesday: verified 09:00-10:00 on Website
-- revamp's Design task (not billable). Worked 19800, billable 7200, Unassigned 5400.
-- The week before: two hours on Tuesday the 10th.
-- Lucas (Chicago, -05), Monday: verified 09:00-10:00 on Website revamp, break 10:00-10:30;
-- an hour on the 23rd is outside the week. Ivan: three hours on the 18th.
insert into public.time_segments
  (org_id, user_id, day, start_at, end_at, type, project_id, task_id, counted, flagged, excluded)
values
  (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 11:00:00-07', 'verified', :revamp, null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07', 'idle', null, null, true, true, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07', 'unverified', null, null, true, true, true),
  (:org, :erin, '2026-03-16', '2026-03-16 11:45:00-07', '2026-03-16 12:00:00-07', 'break', null, null, false, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 12:00:00-07', '2026-03-16 13:00:00-07', 'verified', :internal, null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 13:00:00-07', '2026-03-16 14:00:00-07', 'manual', null, null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 14:00:00-07', '2026-03-16 14:10:00-07', 'pause', null, null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 14:10:00-07', '2026-03-16 14:15:00-07', 'pause_over_cap', null, null, false, true, false),
  (:org, :erin, '2026-03-17', '2026-03-17 09:00:00-07', '2026-03-17 10:00:00-07', 'verified', :revamp, :task, true, false, false),
  (:org, :erin, '2026-03-10', '2026-03-10 09:00:00-07', '2026-03-10 11:00:00-07', 'verified', null, null, true, false, false),
  (:org, :lucas, '2026-03-16', '2026-03-16 09:00:00-05', '2026-03-16 10:00:00-05', 'verified', :revamp, null, true, false, false),
  (:org, :lucas, '2026-03-16', '2026-03-16 10:00:00-05', '2026-03-16 10:30:00-05', 'break', null, null, false, false, false),
  (:org, :lucas, '2026-03-23', '2026-03-23 09:00:00-05', '2026-03-23 10:00:00-05', 'verified', null, null, true, false, false),
  (:org, :ivan, '2026-03-18', '2026-03-18 09:00:00+00', '2026-03-18 12:00:00+00', 'verified', null, null, true, false, false);

insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000e1', :org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-insights'),
       ('00000000-0000-4000-8000-0000000000e2', :org, :lucas, 'macos', '26.0', '0.1.0', 'hash-lucas-insights');

-- Check-ins. Erin: passes of 1000, 2000, 4000 and 9000 ms and one never shown, a miss with
-- the reason Meeting and one without, a failure, and one deferred for a call; a miss on
-- the 15th (the week before) and a pass on the 23rd (after). The week before: a pass of
-- 3000 ms. Lucas: passes of 100 and 200 ms and one deferred while presenting.
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome, response_ms, missed_reason_kind, deferral_reason)
values
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 10:00:00-07', '2026-03-16 10:00:02-07', 'pass', 1000, null, null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 10:30:00-07', '2026-03-16 10:30:02-07', 'pass', 2000, null, null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 12:30:00-07', '2026-03-16 12:30:02-07', 'pass', 4000, null, null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 13:30:00-07', '2026-03-16 13:30:02-07', 'pass', 9000, null, null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-17 08:00:00-07', null, 'pass', null, null, null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 11:00:00-07', '2026-03-16 11:00:03-07', 'miss', null, 'meeting', null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-17 09:30:00-07', '2026-03-17 09:30:03-07', 'miss', null, null, null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-17 09:45:00-07', '2026-03-17 09:45:03-07', 'failed', 800, null, null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 15:00:00-07', null, 'deferred', null, null, 'call'),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-15 23:59:50-07', '2026-03-15 23:59:52-07', 'miss', null, null, null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-23 00:00:30-07', '2026-03-23 00:00:32-07', 'pass', 500, null, null),
  (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-10 10:00:00-07', '2026-03-10 10:00:02-07', 'pass', 3000, null, null),
  (gen_random_uuid(), :org, :lucas, '00000000-0000-4000-8000-0000000000e2', '2026-03-16 09:30:00-05', '2026-03-16 09:30:02-05', 'pass', 100, null, null),
  (gen_random_uuid(), :org, :lucas, '00000000-0000-4000-8000-0000000000e2', '2026-03-16 09:45:00-05', '2026-03-16 09:45:02-05', 'pass', 200, null, null),
  (gen_random_uuid(), :org, :lucas, '00000000-0000-4000-8000-0000000000e2', '2026-03-16 11:00:00-05', null, 'deferred', null, null, 'presenting');

-- Attendance. Erin works Monday to Friday 09:00-17:00 Los Angeles time; Friday the 20th
-- is a holiday for everyone. Monday she clocks in at 09:20 (late; a session that ended
-- before the shift doesn't count), Tuesday 09:10, Wednesday 09:15, Thursday 08:30 (all on
-- time). Lucas works Monday nights 22:00-06:00 Chicago time and clocks in at 22:30 (late).
-- Nobody clocks in the week before.
delete from public.shifts;
insert into public.holidays (org_id, day, name) values (:org, '2026-03-20', 'Spring day');
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values
  (:org, :erin, '{1,2,3,4,5}', '09:00', '17:00', 'America/Los_Angeles'),
  (:org, :lucas, '{1}', '22:00', '06:00', 'America/Chicago');
-- These shifts applied all along (#329: a shift set now applies from today on).
delete from public.shift_history where valid_to is not null;
update public.shift_history set valid_from = '-infinity';
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
values
  (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 07:00:00-07', '2026-03-16 08:00:00-07', gen_random_uuid()),
  (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-16 09:20:00-07', '2026-03-16 17:00:00-07', gen_random_uuid()),
  (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-17 09:10:00-07', '2026-03-17 17:00:00-07', gen_random_uuid()),
  (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-18 09:15:00-07', '2026-03-18 17:00:00-07', gen_random_uuid()),
  (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-19 08:30:00-07', '2026-03-19 17:00:00-07', gen_random_uuid()),
  (:org, :lucas, '00000000-0000-4000-8000-0000000000e2', '2026-03-16 22:30:00-05', '2026-03-17 06:00:00-05', gen_random_uuid());

-- Needs review: an unreviewed flag on Erin's Tuesday, a reviewed one on Lucas's Monday,
-- and a Tamper period on Erin's Wednesday.
insert into public.anticheat_flags (org_id, user_id, day, kind, details, reviewed_at, reviewed_by)
values
  (:org, :erin, '2026-03-17', 'fast_response', '{}', null, null),
  (:org, :lucas, '2026-03-16', 'low_variance', '{}', now(), :max);
insert into public.status_periods (org_id, user_id, status, reason, start_at, end_at)
values (:org, :erin, 'tamper', 'agent_stopped', '2026-03-18 13:00:00-07', '2026-03-18 13:30:00-07');

-- Who is in it ----------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select is(pg_temp.names(pg_temp.ins()), 'Erin Employee, Ivan Inactive, Lucas Martin',
  'a manager: their reports by name; a deactivated person without data is out');
select is(
  (select string_agg(o ->> 'full_name', ', ') from jsonb_array_elements(pg_temp.ins() -> 'people_options') o),
  'Erin Employee, Ivan Inactive, Lucas Martin, Zed Inactive',
  'the person filter offers everyone in scope, by name');
select is(pg_temp.names(pg_temp.ins(p_ids => array[:erin]::uuid[])), 'Erin Employee', 'filter: one person');
select is(pg_temp.names(pg_temp.ins(p_team => :team)), 'Erin Employee', 'filter: a team');
select throws_ok(format($$ select pg_temp.ins(p_ids => array[%L]::uuid[]) $$, :ada),
  '42501', 'forbidden', 'a manager cannot name their own manager');
select throws_ok($$ select pg_temp.ins('2026-03-22', '2026-03-16') $$, '22023', 'invalid_range', 'a backwards range');
select throws_ok($$ select pg_temp.ins('2025-03-16', '2026-03-22') $$, '22023', 'invalid_range', 'over a year');

select pg_temp.act_as(:ada);
select is(pg_temp.names(pg_temp.ins()), 'Erin Employee, Ivan Inactive, Lucas Martin, Max Manager, Mia Manager',
  'the owner: everyone but themselves');

select pg_temp.act_as(:mia);
select is(pg_temp.names(pg_temp.ins()), '', 'a manager of nobody involved sees none of it');
select pg_temp.act_as_postgres();
-- Starts yesterday: "active" is the manager's local date (#291).
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org, :max, :mia, current_date - 1, current_date + 3);
select pg_temp.act_as(:mia);
select is(pg_temp.names(pg_temp.ins()), 'Erin Employee, Ivan Inactive, Lucas Martin',
  'an active delegate sees the manager''s reports (the delegated scope)');

select pg_temp.act_as(:erin);
select is(pg_temp.names(pg_temp.ins()), '', 'an employee has no team');
select is(pg_temp.names(pg_temp.ins(p_ids => array[:erin]::uuid[])), 'Erin Employee',
  'but gets their own numbers (My data)');
select throws_ok(format($$ select pg_temp.ins(p_ids => array[%L]::uuid[]) $$, :lucas),
  '42501', 'forbidden', 'and cannot name a peer');

-- The same numbers as Reports (INS-04) ------------------------------------------------------------

select pg_temp.act_as(:max);
select is(pg_temp.mismatches('2026-03-16', '2026-03-22'), '', 'manager, the week: every person and total equals Reports');
select is(pg_temp.mismatches('2026-03-09', '2026-03-15'), '', 'manager, the week before');
select is(pg_temp.mismatches('2026-03-01', '2026-03-31'), '', 'manager, the month');
select is(pg_temp.mismatches('2026-03-16', '2026-03-16'), '', 'manager, one day');
select is(pg_temp.mismatches('2026-03-16', '2026-03-22', :team), '', 'manager, a team');
select is(pg_temp.mismatches('2026-03-16', '2026-03-22', null, array[:lucas]::uuid[]), '', 'manager, one person');
select is(pg_temp.project_mismatches('2026-03-16', '2026-03-22'), '', 'projects and tasks equal report_task_rows');
select pg_temp.act_as(:ada);
select is(pg_temp.mismatches('2026-03-16', '2026-03-22'), '', 'owner, the week');
select is(pg_temp.project_mismatches('2026-03-01', '2026-03-31'), '', 'owner, projects for the month');
select pg_temp.act_as(:erin);
select is(pg_temp.mismatches('2026-03-16', '2026-03-22', null, array[:erin]::uuid[]), '', 'Erin, her own week');

-- Time ------------------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select is(pg_temp.person(:erin, 'worked_s'), '19800', 'worked');
select is(pg_temp.person(:erin, 'pause_over_cap_s'), '300', 'pause over the cap');
select is(pg_temp.person(:erin, 'billable_s'), '7200',
  'billable: the task''s flag, else the project''s (Internal and the Design task are not)');
select is(pg_temp.person(:erin, 'unassigned_s'), '5400', 'Unassigned: worked time without a project');
select is(pg_temp.person(:lucas, 'billable_s'), '3600', 'Lucas''s hour on Website revamp is billable');
select is(pg_temp.ins() -> 'totals' ->> 'billable_s', '10800', 'the team''s billable time');
select is(
  (select jsonb_agg(jsonb_build_array(t ->> 'name', t ->> 'billable_target_pct', t ->> 'worked_s', t ->> 'billable_s'))
   from jsonb_array_elements(pg_temp.ins() -> 'teams') t),
  '[["Web", "60", "19800", "7200"]]'::jsonb, 'the billable share per team, with its target');
select is(pg_temp.ins(p_team => :team) ->> 'billable_target_pct', '60', 'a team''s target when filtered to it');
select is(pg_temp.ins() ->> 'billable_target_pct', null, 'no target without a team');

select is(
  (select jsonb_agg(jsonb_build_array(x ->> 'project_name', x ->> 'client_name', x ->> 'task_name', x ->> 'worked_s', x ->> 'billable')
     order by ord)
   from jsonb_array_elements(pg_temp.ins() -> 'projects') with ordinality t (x, ord)),
  '[["Website revamp", "Northwind", null, "10800", "true"],
    ["Website revamp", "Northwind", "Design", "3600", "false"],
    ["Internal", null, null, "3600", "false"],
    [null, null, null, "16200", "false"]]'::jsonb,
  'hours by client, project and task; Unassigned last');

-- Caps and overtime: off by default, then a 4 h day, a 5 h week and 10-minute daily caps.
select is(pg_temp.person(:erin, 'overtime_daily_s') || '/' || pg_temp.person(:erin, 'overtime_weekly_s')
  || '/' || pg_temp.person(:erin, 'pause_days_over_cap') || '/' || pg_temp.person(:erin, 'break_days_over_cap'),
  '0/0/0/0', 'no overtime while the thresholds are off; pauses are within the 60-minute day');
select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"overtime_daily_hours": 4, "overtime_weekly_hours": 5,
  "pause_daily_max_min": 10, "break_daily_max_min": 10}'::jsonb where id = :org;
select pg_temp.act_as(:max);
select is(pg_temp.person(:erin, 'overtime_daily_s') || '/' || pg_temp.person(:erin, 'overtime_days'),
  '1800/1', 'daily overtime: Monday''s 4.5 h is 30 minutes over 4 h');
select is(pg_temp.person(:erin, 'overtime_weekly_s') || '/' || pg_temp.person(:erin, 'overtime_weeks'),
  '1800/1', 'weekly overtime: 5.5 h is 30 minutes over 5 h');
select is(pg_temp.person(:erin, 'pause_days_over_cap') || '/' || pg_temp.person(:erin, 'break_days_over_cap'),
  '1/1', 'a day over the daily pause cap and one over the break cap');
select is(pg_temp.ins() -> 'totals' ->> 'break_days_over_cap', '2', 'Lucas''s half-hour break is over too');
select is(pg_temp.ins() -> 'overtime', '{"daily_hours": 4, "weekly_hours": 5}'::jsonb, 'the thresholds come with it');
select is(pg_temp.mismatches('2026-03-16', '2026-03-22'), '', 'and Reports still agree');

-- Check-ins -----------------------------------------------------------------------------------

select is(
  (select jsonb_build_object('shown', t -> 'checkins_shown', 'deferred', t -> 'checkins_deferred',
     'call', t -> 'deferred_call', 'presenting', t -> 'deferred_presenting',
     'meeting', t -> 'miss_meeting', 'none', t -> 'miss_none', 'median', t -> 'median_response_ms')
   from (select pg_temp.ins() -> 'totals' as t) x),
  '{"shown": 10, "deferred": 2, "call": 1, "presenting": 1, "meeting": 1, "none": 1, "median": 1500}'::jsonb,
  'shown, deferred by reason, misses by reason and the team median of every pass');

-- Attendance ------------------------------------------------------------------------------------

select is(
  (select format('%s shift days, %s on time, %s late, %s without a clock-in, %s on leave, %s s scheduled',
     p ->> 'shift_days', p ->> 'on_time', p ->> 'late_clock_ins', p ->> 'no_clock_in', p ->> 'leave_shift_days',
     p ->> 'scheduled_s')
   from jsonb_array_elements(pg_temp.ins() -> 'people') p where p ->> 'user_id' = :erin),
  '4 shift days, 3 on time, 1 late, 0 without a clock-in, 1 on leave, 115200 s scheduled',
  'Erin: Monday late, three days on time, the holiday left out');
select is(
  (select format('%s/%s/%s/%s', p ->> 'shift_days', p ->> 'on_time', p ->> 'late_clock_ins', p ->> 'scheduled_s')
   from jsonb_array_elements(pg_temp.ins() -> 'people') p where p ->> 'user_id' = :lucas),
  '1/0/1/28800', 'Lucas: one night shift, late');
select is(pg_temp.ins('2026-03-09', '2026-03-15') -> 'totals' ->> 'no_clock_in', '6',
  'the week before: five of Erin''s days and Lucas''s night without a clock-in');

-- Leave hours (LV-05, #329): the holiday counts Erin's eight shift hours, apart from worked time.
select is(pg_temp.person(:erin, 'leave_s') || '/' || pg_temp.person(:lucas, 'leave_s'), '28800/0',
  'leave: the holiday is Erin''s shift hours that day (Lucas has no shift on Fridays)');
select is(
  (select s ->> 'leave_s' from jsonb_array_elements(pg_temp.ins() -> 'series') s where s ->> 'bucket' = '2026-03-20'),
  '28800', 'in Friday''s bucket');
select is(pg_temp.ins() -> 'totals' ->> 'leave_s', '28800', 'and in the totals');
select is(pg_temp.ins('2026-03-09', '2026-03-15') -> 'totals' ->> 'leave_s', '0', 'none the week before');

select pg_temp.act_as_postgres();
delete from public.holidays where org_id = :org and day = '2026-03-20';
select pg_temp.act_as(:max);
select is(pg_temp.person(:erin, 'no_clock_in') || '/' || pg_temp.person(:erin, 'leave_shift_days'),
  '1/0', 'without the holiday, Friday is a shift day without a clock-in');

select pg_temp.act_as_postgres();
insert into public.leave_requests (org_id, user_id, leave_type_id, paid, kind, first_day, last_day,
  start_at, end_at, timezone, status)
select :org, :erin, t.id, true, 'days', '2026-03-20', '2026-03-20',
  '2026-03-20 00:00:00-07', '2026-03-21 00:00:00-07', 'America/Los_Angeles', 'approved'
from public.leave_types t where t.org_id = :org and t.name = 'Vacation';
select pg_temp.act_as(:max);
select is(pg_temp.person(:erin, 'no_clock_in') || '/' || pg_temp.person(:erin, 'leave_shift_days'),
  '0/1', 'approved leave leaves the day out too');

-- Trends and the series ------------------------------------------------------------------------

select is(
  (select format('%s..%s %s', j ->> 'previous_from', j ->> 'previous_to', j ->> 'bucket') from (select pg_temp.ins() j) x),
  '2026-03-09..2026-03-15 day', 'the previous range has the same length, just before; by day');
select is(
  (select format('%s worked, %s people, %s shown, median %s', t ->> 'worked_s', t ->> 'people',
     t ->> 'checkins_shown', t ->> 'median_response_ms')
   from (select pg_temp.ins() -> 'previous_totals' t) x),
  '7200 worked, 2 people, 2 shown, median 3000', 'the previous week''s totals');
select is(jsonb_array_length(pg_temp.ins() -> 'series'), 7, 'a bucket per day, empty days too');
select is(
  (select format('%s %s %s', s ->> 'bucket', s ->> 'worked_s', s ->> 'checkins_passed')
   from jsonb_array_elements(pg_temp.ins() -> 'series') s where s ->> 'bucket' = '2026-03-16'),
  '2026-03-16 19800 6', 'Monday''s bucket: everyone''s worked time and passes');
select is(
  (select format('%s %s', j ->> 'bucket', jsonb_array_length(j -> 'series'))
   from (select pg_temp.ins('2026-01-01', '2026-03-31') j) x),
  'week 13', 'over two months: 7-day buckets from the start');
select is(
  (select sum((s ->> 'worked_s')::bigint) from jsonb_array_elements(pg_temp.ins('2026-01-01', '2026-03-31') -> 'series') s),
  (select (pg_temp.ins('2026-01-01', '2026-03-31') -> 'totals' ->> 'worked_s')::numeric),
  'the buckets add up to the total');
select is(
  (select jsonb_agg(jsonb_build_array(s ->> 'bucket', s ->> 'project_id', s ->> 'worked_s') order by s ->> 'bucket', s ->> 'project_id')
   from jsonb_array_elements(pg_temp.ins() -> 'project_series') s where s ->> 'task_id' is null and s ->> 'project_id' is not null),
  format('[["2026-03-16", "%s", "10800"], ["2026-03-16", "%s", "3600"]]', :revamp, :internal)::jsonb,
  'project hours per bucket');

-- Needs review --------------------------------------------------------------------------------

select is(
  (select jsonb_agg(jsonb_build_array(r ->> 'full_name', r ->> 'day', r ->> 'anomaly_flags', r ->> 'needs_review', r ->> 'tamper'))
   from jsonb_array_elements(pg_temp.ins() -> 'review_days') r),
  '[["Erin Employee", "2026-03-18", "0", "0", "1"],
    ["Erin Employee", "2026-03-17", "1", "1", "0"],
    ["Lucas Martin", "2026-03-16", "1", "0", "0"]]'::jsonb,
  'the days to review, newest first, with their flags and Tamper');
select is(
  (select format('%s flags, %s to review, %s tamper', t ->> 'anomaly_flags', t ->> 'needs_review', t ->> 'tamper')
   from (select pg_temp.ins() -> 'totals' t) x),
  '2 flags, 1 to review, 1 tamper', 'the totals count them');

-- Billable target ---------------------------------------------------------------------------------

select throws_ok(format($$ select public.set_team_billable_target(%L, 70) $$, :team),
  '42501', 'admin_only', 'a manager cannot set a team''s target');
select pg_temp.act_as(:ada);
select throws_ok(format($$ select public.set_team_billable_target(%L, 0) $$, :team),
  '22023', 'invalid_target', 'a target is 1 to 100 percent');
select lives_ok(format($$ select public.set_team_billable_target(%L, 75) $$, :team), 'an owner sets it');
select ok(
  (select metadata from public.audit_log where action = 'team.billable_target_changed' order by at desc, id desc limit 1)
    @> jsonb_build_object('team_id', :team, 'name', 'Web', 'from', 60, 'to', 75), 'audit-logged with before and after');
select lives_ok(format($$ select public.set_team_billable_target(%L, null) $$, :team), 'and turns it off');
select is((select billable_target_pct from public.teams where id = :team), null, 'off is null');

-- The person-day cache (#329) -----------------------------------------------------------------------
-- Days that are over are kept (insights_daily); the reader takes them and computes the rest.
-- After any change to what a day is computed from, the reader still equals the computation.

select pg_temp.act_as_postgres();
create function pg_temp.cache_diff(p_from date default '2026-03-01', p_to date default '2026-03-31')
returns text
language sql as $$
  with ids as (select array_agg(id) as a from public.users),
  a as (select d.user_id, d.day, to_jsonb(d) - 'pass_ms' as j, array(select unnest(d.pass_ms) order by 1) as ms
        from internal.insights_days((select a from ids), p_from, p_to, now()) d),
  b as (select d.user_id, d.day, to_jsonb(d) - 'pass_ms' as j, array(select unnest(d.pass_ms) order by 1) as ms
        from internal.insights_days_live((select a from ids), p_from, p_to, now()) d),
  x as ((select * from a except all select * from b) union all (select * from b except all select * from a))
  select coalesce(string_agg(distinct format('%s %s', x.user_id, x.day), ', '), '') from x
$$;

select is(pg_temp.cache_diff(), '', 'nothing kept yet: computed');
select cmp_ok(internal.insights_daily_fill(1000000), '>', 0, 'a fill keeps the days that are over');
select is(
  (select count(*)::int from public.insights_daily where day between '2026-03-01' and '2026-03-31'),
  (select count(*)::int * 31 from public.users), 'every person-day of March, empty ones too');
select is(
  (select count(*)::int from public.insights_daily where day > internal.insights_daily_last(now())),
  0, 'nothing from the last three days');
select is(internal.insights_daily_fill(), 0, 'a second fill has nothing to do');
select is(pg_temp.cache_diff(), '', 'kept days read the same as computed');
select is(pg_temp.cache_diff('2026-03-01', current_date), '', 'up to today (the last days computed)');
select pg_temp.act_as(:max);
select is(pg_temp.mismatches('2026-03-16', '2026-03-22'), '', 'Insights still equal Reports');
select is(pg_temp.mismatches('2026-03-01', '2026-03-31'), '', 'for the month too');
select is(pg_temp.project_mismatches('2026-03-01', '2026-03-31'), '', 'and the projects');
select pg_temp.act_as_postgres();
update public.insights_daily set worked_s = worked_s + 1 where user_id = :erin and day = '2026-03-16';
select pg_temp.act_as(:max);
select is(pg_temp.person(:erin, 'worked_s'), '19801', 'the page reads the kept days');
select pg_temp.act_as_postgres();
update public.insights_daily set worked_s = worked_s - 1 where user_id = :erin and day = '2026-03-16';

-- Each change forgets the days it touches (all in the first week of March, which nothing
-- below reads).
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
values (:org, :erin, '2026-03-04', '2026-03-04 13:00:00-08', '2026-03-04 14:00:00-08', 'verified', true, false);
select is(pg_temp.cache_diff(), '', 'a segment');
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome, response_ms)
values (gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-04 13:30:00-08',
  '2026-03-04 13:30:02-08', 'pass', 2000);
select is(pg_temp.cache_diff(), '', 'a check-in');
update public.checkin_events set outcome = 'miss', response_ms = null
where user_id = :erin and scheduled_at = '2026-03-04 13:30:00-08';
select is(pg_temp.cache_diff(), '', 'a check-in''s outcome');
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
values (:org, :erin, '00000000-0000-4000-8000-0000000000e1', '2026-03-03 09:40:00-08', '2026-03-03 17:00:00-08', gen_random_uuid());
select is(pg_temp.cache_diff(), '', 'a clock session (attended, and late)');
select is((select count(*)::int from public.late_clock_ins where user_id = :erin and day = '2026-03-03'), 1,
  'its late clock-in was recorded');
delete from public.late_clock_ins where user_id = :erin and day = '2026-03-03';
select is(pg_temp.cache_diff(), '', 'a late clock-in');
insert into public.leave_requests (org_id, user_id, leave_type_id, paid, kind, first_day, last_day,
  start_at, end_at, timezone, status)
select :org, :erin, t.id, true, 'days', '2026-03-05', '2026-03-05',
  '2026-03-05 00:00:00-08', '2026-03-06 00:00:00-08', 'America/Los_Angeles', 'approved'
from public.leave_types t where t.org_id = :org and t.name = 'Vacation';
select is(pg_temp.cache_diff(), '', 'approved leave');
insert into public.holidays (org_id, day, name) values (:org, '2026-03-04', 'Midweek day');
select is(pg_temp.cache_diff(), '', 'a holiday');
update public.anticheat_flags set reviewed_at = null, reviewed_by = null where user_id = :lucas;
select is(pg_temp.cache_diff(), '', 'a flag''s review');
insert into public.status_periods (org_id, user_id, status, reason, start_at, end_at)
values (:org, :lucas, 'tamper', 'agent_stopped', '2026-03-03 13:00:00-06', '2026-03-03 13:30:00-06');
select is(pg_temp.cache_diff(), '', 'a Tamper period');
update public.shift_history set days = '{1,2}' where user_id = :lucas and valid_to is null;
select is(pg_temp.cache_diff(), '', 'shift history');
update public.shift_history set days = '{1}' where user_id = :lucas and valid_to is null;
update public.projects set billable = not billable where id = :revamp;
select is(pg_temp.cache_diff(), '', 'a project''s billable flag');
update public.users set timezone = 'America/Denver' where id = :lucas;
select is(pg_temp.cache_diff(), '', 'a time zone');
select cmp_ok(internal.insights_daily_fill(1000000), '>', 0, 'the next fill keeps them again');
select is(pg_temp.cache_diff(), '', 'and they read the same');
update public.users set timezone = 'America/Chicago' where id = :lucas;
update public.projects set billable = not billable where id = :revamp;

-- Weekly insights email (INS-06) -------------------------------------------------------------------

select pg_temp.act_as(:max);
select is(public.set_weekly_insights(true), true, 'a manager turns the weekly email on');
select pg_temp.act_as_postgres();
select is(internal.weekly_insights_eval('2026-03-23 08:30:00-05'), 0, 'not before 09:00 on the week''s first day');
select is(internal.weekly_insights_eval('2026-03-23 11:30:00-05'), 1, 'Max''s goes out on Monday morning');
select is(
  (select format('%s..%s: %s worked, %s late, %s people', payload ->> 'week_from', payload ->> 'week_to',
     payload -> 'current' ->> 'worked_s', payload -> 'current' ->> 'late_clock_ins', payload -> 'current' ->> 'people')
   from public.email_outbox where template = 'weekly_insights' and to_email = 'manager@acme.test'),
  '2026-03-16..2026-03-22: 34200 worked, 2 late, 3 people',
  'about last week: the direct reports'' totals (Erin, Lucas and Ivan)');
select is(
  (select payload -> 'previous' ->> 'worked_s' from public.email_outbox where template = 'weekly_insights'),
  '7200', 'against the week before');
select is(internal.weekly_insights_eval('2026-03-23 12:00:00-05'), 0, 'once a week');
select is(
  (select count(*)::int from public.email_outbox where template = 'weekly_insights' and to_email <> 'manager@acme.test'),
  0, 'nobody who did not turn it on gets one');
delete from public.users where id = :zed;
select is((select count(*)::int from public.email_outbox where template = 'weekly_insights'), 0,
  'deleting a report''s data removes the emails that added up their numbers');

select * from finish();
rollback;
