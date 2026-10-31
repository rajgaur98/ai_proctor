-- #269: task order (PRJ-05) and reports by task (DSH-10).
begin;
create extension if not exists pgtap with schema extensions;

select plan(37);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set adam '''00000000-0000-4000-8000-0000000000a9'''
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

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- Read as the database owner: tasks by name, the audit log.
create function pg_temp.task(p_name text) returns uuid
language sql security definer as $$ select id from public.project_tasks where name = p_name $$;

create function pg_temp.task_order(p_project uuid) returns text[]
language sql security definer as $$
  select array_agg(name order by sort_order, name) from public.project_tasks where project_id = p_project
$$;

create function pg_temp.reorders(p_project uuid) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log
  where action = 'project.tasks_reordered' and metadata ->> 'project_id' = p_project::text
$$;

-- Adam is a second admin (Ada is the owner).
insert into auth.users (id, email) values (:adam, 'adam@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id, active, timezone)
values (:adam, :org, 'Adam Admin', 'adam@acme.test', 'admin', :ada, true, 'UTC');

insert into public.project_tasks (org_id, project_id, name, billable, archived, sort_order) values
  (:org, :revamp, 'Alpha', true, false, 0),
  (:org, :revamp, 'Beta', true, false, 1),
  (:org, :revamp, 'Gamma', true, false, 2),
  (:org, :revamp, 'Old', true, true, 3),
  (:org, :internal, 'Hiring', false, false, 0);

-- Task order: who may change it ---------------------------------------------------------------

select has_function('public', 'reorder_tasks', array['uuid', 'uuid[]'], 'reorder_tasks exists');

select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.reorder_tasks(%L, array[%L, %L, %L, %L]::uuid[]) $$,
    :revamp, pg_temp.task('Beta'), pg_temp.task('Alpha'), pg_temp.task('Gamma'), pg_temp.task('Old')),
  '42501', 'admin_only', 'reorder_tasks: an employee cannot');

select pg_temp.act_as(:max);
select throws_ok(format($$ select public.reorder_tasks(%L, array[%L, %L, %L, %L]::uuid[]) $$,
    :revamp, pg_temp.task('Beta'), pg_temp.task('Alpha'), pg_temp.task('Gamma'), pg_temp.task('Old')),
  '42501', 'admin_only', 'reorder_tasks: a manager cannot');
select is(pg_temp.task_order(:revamp), array['Alpha', 'Beta', 'Gamma', 'Old'],
  'refused: the order is unchanged');
select is(pg_temp.reorders(:revamp), 0, 'refused: nothing audit-logged');

select pg_temp.act_as(:ada);
select lives_ok(format($$ select public.reorder_tasks(%L, array[%L, %L, %L, %L]::uuid[]) $$,
    :revamp, pg_temp.task('Gamma'), pg_temp.task('Alpha'), pg_temp.task('Old'), pg_temp.task('Beta')),
  'reorder_tasks: the owner reorders');
select is(pg_temp.task_order(:revamp), array['Gamma', 'Alpha', 'Old', 'Beta'], 'the new order is kept');
select is(pg_temp.reorders(:revamp), 1, 'the change is audit-logged');

select pg_temp.act_as_postgres();
select is(
  (select metadata -> 'after' from public.audit_log where action = 'project.tasks_reordered'),
  to_jsonb(array[pg_temp.task('Gamma'), pg_temp.task('Alpha'), pg_temp.task('Old'), pg_temp.task('Beta')]),
  'the audit entry has the new order');
select is(
  (select metadata -> 'before' from public.audit_log where action = 'project.tasks_reordered'),
  to_jsonb(array[pg_temp.task('Alpha'), pg_temp.task('Beta'), pg_temp.task('Gamma'), pg_temp.task('Old')]),
  'the audit entry has the order before');
select is((select actor_id from public.audit_log where action = 'project.tasks_reordered'), :ada::uuid,
  'the audit entry names who did it');

select pg_temp.act_as(:ada);
select lives_ok(format($$ select public.reorder_tasks(%L, array[%L, %L, %L, %L]::uuid[]) $$,
    :revamp, pg_temp.task('Gamma'), pg_temp.task('Alpha'), pg_temp.task('Old'), pg_temp.task('Beta')),
  'reorder_tasks: the same order again');
select is(pg_temp.reorders(:revamp), 1, 'no change: no new audit entry');

select pg_temp.act_as(:adam);
select lives_ok(format($$ select public.reorder_tasks(%L, array[%L, %L, %L, %L]::uuid[]) $$,
    :revamp, pg_temp.task('Alpha'), pg_temp.task('Gamma'), pg_temp.task('Beta'), pg_temp.task('Old')),
  'reorder_tasks: an admin reorders');
select is(pg_temp.task_order(:revamp), array['Alpha', 'Gamma', 'Beta', 'Old'], 'the admin''s order is kept');
select is(pg_temp.reorders(:revamp), 2, 'the admin''s change is audit-logged');

-- Task order: only the project's whole, current list ----------------------------------------

select throws_ok(format($$ select public.reorder_tasks(%L, array[%L, %L, %L]::uuid[]) $$,
    :revamp, pg_temp.task('Alpha'), pg_temp.task('Gamma'), pg_temp.task('Beta')),
  '22023', 'task_list_changed', 'reorder_tasks: a task left out is refused');
select throws_ok(format($$ select public.reorder_tasks(%L, array[%L, %L, %L, %L]::uuid[]) $$,
    :revamp, pg_temp.task('Alpha'), pg_temp.task('Alpha'), pg_temp.task('Beta'), pg_temp.task('Old')),
  '22023', 'task_list_changed', 'reorder_tasks: a task twice is refused');
select throws_ok(format($$ select public.reorder_tasks(%L, array[%L, %L, %L, %L, %L]::uuid[]) $$,
    :revamp, pg_temp.task('Alpha'), pg_temp.task('Gamma'), pg_temp.task('Beta'), pg_temp.task('Old'),
    pg_temp.task('Hiring')),
  '22023', 'task_list_changed', 'reorder_tasks: another project''s task is refused');
select throws_ok(format($$ select public.reorder_tasks(%L, array[%L, %L, %L, null]::uuid[]) $$,
    :revamp, pg_temp.task('Alpha'), pg_temp.task('Gamma'), pg_temp.task('Beta')),
  '22023', 'task_list_changed', 'reorder_tasks: a null is refused');
select throws_ok(format($$ select public.reorder_tasks(%L, null) $$, :revamp),
  '22023', 'task_list_changed', 'reorder_tasks: no list is refused');
select throws_ok($$ select public.reorder_tasks(gen_random_uuid(), '{}') $$,
  '42501', 'project_not_found', 'reorder_tasks: an unknown project is refused');
select is(pg_temp.task_order(:revamp), array['Alpha', 'Gamma', 'Beta', 'Old'], 'refusals leave the order');

select lives_ok($$ select public.save_task(null, '00000000-0000-4000-8000-0000000000f1', 'Delta') $$,
  'save_task: a task added after a reorder');
select is(pg_temp.task_order(:revamp), array['Alpha', 'Gamma', 'Beta', 'Old', 'Delta'],
  'a new task still goes last');

-- Reports by task -----------------------------------------------------------------------------

select pg_temp.act_as_postgres();

-- Erin (America/Los_Angeles), Monday 16 March 2026: Alpha 09:00-10:00 verified and
-- 10:30-10:45 idle (flagged), 10:45-11:00 unverified on Alpha but excluded by a manager;
-- the project with no task 10:00-10:30; a break; Unassigned 11:15-11:45 verified and
-- 11:45-11:50 over the pause cap (flagged, not counted). Lucas (America/Chicago): Beta
-- 09:00-10:00 on the 16th and Alpha on the 23rd (outside the week). Max: Alpha 1 h.
insert into public.time_segments
  (org_id, user_id, day, start_at, end_at, type, project_id, task_id, counted, flagged, excluded)
values
  (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07', 'verified', :revamp, pg_temp.task('Alpha'), true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 10:00:00-07', '2026-03-16 10:30:00-07', 'verified', :revamp, null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 10:30:00-07', '2026-03-16 10:45:00-07', 'idle', :revamp, pg_temp.task('Alpha'), true, true, false),
  (:org, :erin, '2026-03-16', '2026-03-16 10:45:00-07', '2026-03-16 11:00:00-07', 'unverified', :revamp, pg_temp.task('Alpha'), true, true, true),
  (:org, :erin, '2026-03-16', '2026-03-16 11:00:00-07', '2026-03-16 11:15:00-07', 'break', null, null, false, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:15:00-07', '2026-03-16 11:45:00-07', 'verified', null, null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:45:00-07', '2026-03-16 11:50:00-07', 'pause_over_cap', null, null, false, true, false),
  (:org, :lucas, '2026-03-16', '2026-03-16 09:00:00-05', '2026-03-16 10:00:00-05', 'verified', :revamp, pg_temp.task('Beta'), true, false, false),
  (:org, :lucas, '2026-03-23', '2026-03-23 09:00:00-05', '2026-03-23 10:00:00-05', 'verified', :revamp, pg_temp.task('Alpha'), true, false, false),
  (:org, :max, '2026-03-16', '2026-03-16 09:00:00-05', '2026-03-16 10:00:00-05', 'verified', :revamp, pg_temp.task('Alpha'), true, false, false);

-- One person's seconds on a project and task in the week, as "worked/flagged".
create function pg_temp.cell(uid uuid, project uuid, task uuid) returns text
language sql as $$
  select r.worked_s || '/' || r.flagged_s
  from public.report_task_rows('2026-03-16', '2026-03-22') r
  where r.user_id = uid and r.project_id is not distinct from project
    and r.task_id is not distinct from task
$$;

select has_function('public', 'report_task_rows', array['date', 'date', 'uuid[]', 'uuid', 'uuid'],
  'report_task_rows exists');

select pg_temp.act_as(:max);
select is(pg_temp.cell(:erin, :revamp, pg_temp.task('Alpha')), '4500/900',
  'by task: worked and flagged on a task; excluded time is in neither');
select is(pg_temp.cell(:erin, :revamp, null), '1800/0', 'by task: project time with no task');
select is(pg_temp.cell(:erin, null, null), '1800/300', 'by task: Unassigned time, flagged included');
select is(pg_temp.cell(:lucas, :revamp, pg_temp.task('Beta')), '3600/0',
  'by task: only days in the range');
select is((select count(*)::int from public.report_task_rows('2026-03-16', '2026-03-22')), 4,
  'by task: one row per person, project and task with time; breaks and the viewer left out');

-- The same seconds as report_rows, person by person.
select is(
  (select jsonb_object_agg(user_id, jsonb_build_array(w, f)) from (
    select user_id::text, sum(worked_s)::bigint as w, sum(flagged_s)::bigint as f
    from public.report_task_rows('2026-03-16', '2026-03-22') group by user_id) s),
  (select jsonb_object_agg(r ->> 'user_id', jsonb_build_array((r ->> 'worked_s')::bigint, (r ->> 'flagged_s')::bigint))
   from jsonb_array_elements(public.report_rows('2026-03-16', '2026-03-22') -> 'rows') r
   where (r ->> 'worked_s')::bigint > 0 or (r ->> 'flagged_s')::bigint > 0),
  'by task: each person''s worked and flagged add up to their report row');

select pg_temp.act_as(:ada);
select is(pg_temp.cell(:max, :revamp, pg_temp.task('Alpha')), '3600/0',
  'by task: the owner sees the manager''s time');
select is(
  (select count(*)::int from public.report_task_rows('2026-03-16', '2026-03-22', array[:lucas]::uuid[])), 1,
  'by task: narrowed to the people named');

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.report_task_rows('2026-03-16', '2026-03-22', array[:erin]::uuid[])), 3,
  'by task: an employee reads her own rows when she names herself');
select throws_ok(format($$ select * from public.report_task_rows('2026-03-16', '2026-03-22', array[%L]::uuid[]) $$, :lucas),
  '42501', 'forbidden', 'by task: not someone she can''t see');
select throws_ok($$ select * from public.report_task_rows('2026-03-22', '2026-03-16') $$,
  '22023', 'invalid_range', 'by task: the range must run forwards');

select * from finish();
rollback;
