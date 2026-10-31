-- #266 (TS-29): worked seconds per person, project and task for the Timesheets list.
begin;
create extension if not exists pgtap with schema extensions;

select plan(9);

\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''
\set internal '''00000000-0000-4000-8000-0000000000f2'''
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

select has_function('public', 'timesheet_assignment_totals', array['date', 'date'],
  'timesheet_assignment_totals exists');

-- Two tasks on Website revamp, made by Erin's manager.
select pg_temp.act_as(:max);
create temp table tk as
  select public.save_task(null, :revamp, 'Design') as design,
         public.save_task(null, :revamp, 'Testing', false) as testing;
reset role;
grant select on tk to authenticated;

-- Erin, week of Monday 16 March 2026 (-07): 2 h Design, 30 min Testing, 1 h Website revamp
-- without a task, 45 min Internal, 20 min Unassigned; a break (not counted) and excluded
-- flagged time, both left out; the next Monday is outside the week. Lucas: 1 h on Design.
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, project_id, task_id, counted, flagged, excluded)
values
  (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 11:00:00-07', 'verified', :revamp, (select design from tk), true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:00:00-07', '2026-03-16 11:30:00-07', 'verified', :revamp, (select testing from tk), true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:30:00-07', '2026-03-16 12:00:00-07', 'break', null, null, false, false, false),
  (:org, :erin, '2026-03-17', '2026-03-17 09:00:00-07', '2026-03-17 10:00:00-07', 'verified', :revamp, null, true, false, false),
  (:org, :erin, '2026-03-17', '2026-03-17 10:00:00-07', '2026-03-17 10:45:00-07', 'manual', :internal, null, true, false, false),
  (:org, :erin, '2026-03-17', '2026-03-17 10:45:00-07', '2026-03-17 11:05:00-07', 'verified', null, null, true, false, false),
  (:org, :erin, '2026-03-17', '2026-03-17 11:05:00-07', '2026-03-17 11:30:00-07', 'unverified', :revamp, (select design from tk), true, true, true),
  (:org, :erin, '2026-03-23', '2026-03-23 09:00:00-07', '2026-03-23 10:00:00-07', 'verified', :revamp, (select design from tk), true, false, false),
  (:org, :lucas, '2026-03-18', '2026-03-18 09:00:00-05', '2026-03-18 10:00:00-05', 'verified', :revamp, (select design from tk), true, false, false);

select pg_temp.act_as(:max);
select is(
  (select jsonb_agg(jsonb_build_array(
            case a.project_id when :revamp then 'revamp' when :internal then 'internal' else 'unassigned' end,
            case a.task_id when (select design from tk) then 'design' when (select testing from tk) then 'testing' else '' end,
            a.seconds)
          order by a.seconds desc)
   from public.timesheet_assignment_totals('2026-03-16', '2026-03-22') a where a.user_id = :erin),
  '[["revamp", "design", 7200], ["revamp", "", 3600], ["internal", "", 2700], ["revamp", "testing", 1800],["unassigned", "", 1200]]'::jsonb,
  'Erin: worked seconds by project and task; breaks, excluded time and other weeks left out');
select is(
  (select sum(a.seconds)::bigint from public.timesheet_assignment_totals('2026-03-16', '2026-03-22') a where a.user_id = :erin),
  (select t.worked_s from public.timesheet_totals('2026-03-16', '2026-03-22') t where t.user_id = :erin),
  'Erin: the rows add up to timesheet_totals worked seconds (TS-06)');
select is(
  (select sum(a.seconds)::bigint from public.timesheet_assignment_totals('2026-03-16', '2026-03-22') a where a.user_id = :lucas),
  (select t.worked_s from public.timesheet_totals('2026-03-16', '2026-03-22') t where t.user_id = :lucas),
  'Lucas: the same');
select is(
  (select count(distinct a.user_id)::int from public.timesheet_assignment_totals('2026-03-16', '2026-03-22') a),
  2, 'the manager gets both reports');
select is(
  (select sum(a.seconds)::bigint from public.timesheet_assignment_totals('2026-03-16', '2026-03-23') a where a.user_id = :erin),
  (7200 + 3600 + 1800 + 2700 + 1200 + 3600)::bigint, 'the range includes its last day');

-- Visibility is the time_segments policy's.
select pg_temp.act_as(:erin);
select is(
  (select array_agg(distinct a.user_id) from public.timesheet_assignment_totals('2026-03-16', '2026-03-22') a),
  array[:erin::uuid], 'an employee gets only her own time');
select pg_temp.act_as(:lucas);
select is(
  (select array_agg(distinct a.user_id) from public.timesheet_assignment_totals('2026-03-16', '2026-03-22') a),
  array[:lucas::uuid], 'a peer gets nothing of Erin''s');

reset role;
set local role anon;
select throws_ok($$ select * from public.timesheet_assignment_totals('2026-03-16', '2026-03-22') $$,
  '42501', null, 'anon cannot call it');

select * from finish();
rollback;
