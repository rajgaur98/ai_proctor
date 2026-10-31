begin;
create extension if not exists pgtap with schema extensions;

select plan(48);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''
\set internal '''00000000-0000-4000-8000-0000000000f2'''
\set other '''00000000-0000-4000-8000-0000000000f3'''
\set archived '''00000000-0000-4000-8000-0000000000f4'''
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

-- Read as the database owner: dirty_days is closed to the API roles.
create function pg_temp.dirty(uid uuid) returns text
language sql security definer as $$
  select coalesce(string_agg(day::text, ',' order by day), '') from public.dirty_days where user_id = uid
$$;

create function pg_temp.epoch(t timestamptz) returns bigint
language sql as $$ select extract(epoch from t)::bigint $$;

create function pg_temp.audited(act text, ts uuid) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log where action = act and metadata ->> 'timesheet_id' = ts::text
$$;

-- Erin works two projects (Website revamp, Internal); "Other" is not hers and "Archived" is
-- assigned to her but archived. Lucas is only on Website revamp.
insert into public.projects (id, org_id, client_id, name, billable, archived) values
  (:other, :org, null, 'Other', false, false),
  (:archived, :org, null, 'Archived', false, true);
insert into public.project_members (project_id, user_id, org_id) values
  (:archived, :erin, :org);

-- Erin is in America/Los_Angeles; the week of Monday 16 March 2026 is daylight time (-07).
-- Monday: verified 09:00-10:00 (Unassigned), verified 10:00-11:00 (Website revamp), idle
-- 11:00-11:20 (flagged, Unassigned), unpaid break 12:00-12:30. Tuesday: verified 09:00-12:00.
-- The Friday before and the Monday after are other weeks.
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, project_id, counted, flagged)
values
  (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07', 'verified', null, true, false),
  (:org, :erin, '2026-03-16', '2026-03-16 10:00:00-07', '2026-03-16 11:00:00-07', 'verified', :revamp, true, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07', 'idle', null, true, true),
  (:org, :erin, '2026-03-16', '2026-03-16 12:00:00-07', '2026-03-16 12:30:00-07', 'break', null, false, false),
  (:org, :erin, '2026-03-17', '2026-03-17 09:00:00-07', '2026-03-17 12:00:00-07', 'verified', :revamp, true, false),
  (:org, :erin, '2026-03-13', '2026-03-13 09:00:00-07', '2026-03-13 10:00:00-07', 'verified', null, true, false),
  (:org, :erin, '2026-03-23', '2026-03-23 09:00:00-07', '2026-03-23 10:00:00-07', 'verified', null, true, false),
  (:org, :lucas, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07', 'verified', null, true, false);

select pg_temp.act_as(:erin);
create temp table ts as select public.ensure_timesheet(:erin, '2026-03-16') as id;
grant select on ts to authenticated;

-- Who and what ----------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select throws_ok($$ select public.reassign_my_time('2026-03-16 09:00:00-07', '2026-03-16 09:00:00-07', '00000000-0000-4000-8000-0000000000f2') $$,
  '22023', 'invalid_range', 'reassign: the end follows the start');
select throws_ok($$ select public.reassign_my_time('2026-03-16 09:00:00-07', now() + interval '1 hour', '00000000-0000-4000-8000-0000000000f2') $$,
  '22023', 'in_the_future', 'reassign: not time that has not happened');
select throws_ok(format($$ select public.reassign_my_time('2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07', %L, %L) $$,
  '00000000-0000-4000-8000-0000000000f2', repeat('x', 501)),
  '22023', 'invalid_reason', 'reassign: a reason is at most 500 characters');
select throws_ok($$ select public.reassign_my_time('2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07', '00000000-0000-4000-8000-0000000000f3') $$,
  '22023', 'project_not_allowed', 'reassign: not a project the employee is not assigned to');
select throws_ok($$ select public.reassign_my_time('2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07', '00000000-0000-4000-8000-0000000000f4') $$,
  '22023', 'project_not_allowed', 'reassign: not an archived project');
select throws_ok($$ select public.reassign_my_time('2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07', gen_random_uuid()) $$,
  '22023', 'project_not_allowed', 'reassign: not an unknown project');
select throws_ok($$ select public.reassign_my_time('2026-03-15 20:00:00-07', '2026-03-16 10:00:00-07', '00000000-0000-4000-8000-0000000000f2') $$,
  '22023', 'outside_week', 'reassign: the span stays inside one week');
select throws_ok($$ select public.reassign_my_time('2026-03-16 12:00:00-07', '2026-03-16 12:30:00-07', '00000000-0000-4000-8000-0000000000f2') $$,
  '22023', 'no_counted_time', 'reassign: not an unpaid break (not counted time)');
select throws_ok($$ select public.reassign_my_time('2026-03-18 09:00:00-07', '2026-03-18 10:00:00-07', '00000000-0000-4000-8000-0000000000f2') $$,
  '22023', 'no_counted_time', 'reassign: there has to be time to move');
select is((select count(*)::int from public.timesheet_edits), 0, 'reassign: refused attempts leave nothing behind');

-- Tagging Unassigned time ----------------------------------------------------------------

select pg_temp.act_as_postgres();
delete from public.dirty_days;
select pg_temp.act_as(:erin);
create temp table tagged as
select public.reassign_my_time('2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07',
  '00000000-0000-4000-8000-0000000000f2', '  Was the internal sync  ') as id;
grant select on tagged to authenticated;
select is(
  (select (kind, editor_id, user_id, project_id, reason, timesheet_id = (select id from ts))::text
   from public.timesheet_edits where id = (select id from tagged)),
  '(employee_project,00000000-0000-4000-8000-0000000000c1,00000000-0000-4000-8000-0000000000c1,00000000-0000-4000-8000-0000000000f2,"Was the internal sync",t)',
  'tag: stored as an employee edit by the employee, reason trimmed');
select is((select detail -> 'before_projects' from public.timesheet_edits where id = (select id from tagged)),
  '[null]'::jsonb, 'tag: the projects the span had are kept in the edit');
select lives_ok($$ select public.reassign_my_time('2026-03-17 09:00:00-07', '2026-03-17 10:00:00-07', null) $$,
  'move: assigned time can go back to Unassigned, no reason needed');
select is((select reason from public.timesheet_edits where kind = 'employee_project' and start_at = '2026-03-17 09:00:00-07'),
  null, 'move: the reason is optional');
select is((select (status, submitted_at is null)::text from public.timesheets where id = (select id from ts)), '(draft,t)',
  'tag: the week stays a draft');
select pg_temp.act_as_postgres();
select is(pg_temp.dirty(:erin), '2026-03-16,2026-03-17', 'tag: marks the days dirty so the rebuild applies it');
select is(pg_temp.audited('timesheet.project_reassigned', (select id from ts)), 2, 'audit: each re-assignment is logged');
select is(
  (select (actor_id, target_user_id, metadata ->> 'project_id', metadata -> 'before_projects')::text from public.audit_log
   where action = 'timesheet.project_reassigned' and metadata ->> 'edit_id' = (select id::text from tagged)),
  '(00000000-0000-4000-8000-0000000000c1,00000000-0000-4000-8000-0000000000c1,00000000-0000-4000-8000-0000000000f2,[null])',
  'audit: who, the new project and the old ones');
select is(pg_temp.audited('timesheet.edited', (select id from ts)), 0, 'audit: not recorded as a manager edit');
select is((select count(*)::int from public.notifications where user_id = :erin), 0, 'notify: the employee is not told of their own change');

-- Rebuild input ------------------------------------------------------------------------------

select is(public.segment_inputs(:erin, '2026-03-16') -> 'input' -> 'projectEdits',
  jsonb_build_array(jsonb_build_object('start', pg_temp.epoch('2026-03-16 09:00:00-07'),
    'end', pg_temp.epoch('2026-03-16 10:00:00-07'), 'projectId', '00000000-0000-4000-8000-0000000000f2',
    'taskId', null)),
  'segment_inputs: the employee edit reaches buildSegments as projectEdits');
select is(public.segment_inputs(:erin, '2026-03-17') -> 'input' -> 'projectEdits',
  jsonb_build_array(jsonb_build_object('start', pg_temp.epoch('2026-03-17 09:00:00-07'),
    'end', pg_temp.epoch('2026-03-17 10:00:00-07'), 'projectId', null, 'taskId', null)),
  'segment_inputs: Unassigned goes through as a null project, only on the day it touches');
select is(public.segment_inputs(:erin, '2026-03-18') -> 'input' -> 'projectEdits', '[]'::jsonb,
  'segment_inputs: other days have none');

-- Who sees it ----------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.timesheet_edits where kind = 'employee_project'), 2, 'RLS: the employee sees their own edits');
select pg_temp.act_as(:max);
select is((select jsonb_agg(editor_id order by seq)::text from public.timesheet_edits where kind = 'employee_project'),
  '["00000000-0000-4000-8000-0000000000c1", "00000000-0000-4000-8000-0000000000c1"]',
  'RLS: the manager sees them, authored by the employee');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.timesheet_edits), 0, 'RLS: a peer sees none');
select throws_ok($$ select public.reassign_my_time('2026-03-16 10:00:00-07', '2026-03-16 11:00:00-07', '00000000-0000-4000-8000-0000000000f1') $$,
  '22023', 'no_counted_time', 'reassign: only over the caller''s own time (Lucas has none then)');
select lives_ok($$ select public.reassign_my_time('2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07', '00000000-0000-4000-8000-0000000000f1') $$,
  'reassign: a peer moves only their own time');
select is((select count(*)::int from public.timesheet_edits where user_id = :erin), 0, 'reassign: nothing is written for Erin by a peer');
select throws_ok($$ insert into public.timesheet_edits (org_id, timesheet_id, user_id, kind, start_at, end_at)
  select org_id, id, user_id, 'employee_project', now() - interval '1 hour', now() from public.timesheets $$,
  '42501', null, 'no direct client writes: edits');

-- Flagged time: only the project moves -----------------------------------------------------

select pg_temp.act_as(:erin);
select lives_ok($$ select public.reassign_my_time('2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07', '00000000-0000-4000-8000-0000000000f1') $$,
  'flagged: the project of flagged time can be changed');
select pg_temp.act_as(:max);
select is(
  (select (flagged, excluded)::text from public.time_segments where user_id = :erin and type = 'idle'),
  '(t,f)', 'flagged: it stays flagged and undecided (the review is the manager''s)');
select lives_ok($$ select public.edit_segment((select id from ts), 'exclude', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07', null, 'Not work') $$,
  'flagged: the manager excludes it');
select pg_temp.act_as(:erin);
select throws_ok($$ select public.reassign_my_time('2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07', '00000000-0000-4000-8000-0000000000f2') $$,
  '22023', 'no_counted_time', 'flagged: excluded time is not counted, so it cannot be moved');

-- Precedence with manager edits: the latest edit over a span wins --------------------------

select pg_temp.act_as(:max);
select lives_ok($$ select public.edit_segment((select id from ts), 'project', '2026-03-16 09:00:00-07', '2026-03-16 09:30:00-07', '00000000-0000-4000-8000-0000000000f1', 'It was client work') $$,
  'precedence: the manager changes part of the span afterwards');
select pg_temp.act_as_postgres();
select is(
  (select jsonb_agg(jsonb_build_object('s', e ->> 'start', 'p', e ->> 'projectId') order by ord)
   from jsonb_array_elements(public.segment_inputs(:erin, '2026-03-16') -> 'input' -> 'projectEdits') with ordinality as t(e, ord)
   where (e ->> 'start')::bigint = pg_temp.epoch('2026-03-16 09:00:00-07')),
  format('[{"s": "%s", "p": "00000000-0000-4000-8000-0000000000f2"}, {"s": "%s", "p": "00000000-0000-4000-8000-0000000000f1"}]',
    pg_temp.epoch('2026-03-16 09:00:00-07'), pg_temp.epoch('2026-03-16 09:00:00-07'))::jsonb,
  'precedence: projectEdits lists the employee''s edit before the manager''s later one, so the manager''s wins');
select pg_temp.act_as(:erin);
select lives_ok($$ select public.reassign_my_time('2026-03-16 09:00:00-07', '2026-03-16 09:30:00-07', '00000000-0000-4000-8000-0000000000f2') $$,
  'precedence: the employee can change it again while the week is theirs');
select pg_temp.act_as_postgres();
select is(
  (select e ->> 'projectId' from jsonb_array_elements(public.segment_inputs(:erin, '2026-03-16') -> 'input' -> 'projectEdits') with ordinality as t(e, ord)
   order by ord desc limit 1),
  '00000000-0000-4000-8000-0000000000f2', 'precedence: and then theirs is the latest, so it wins');

-- A rebuild replaces the rows, a new tag survives in the inputs ----------------------------

select is(
  internal.replace_day_segments(:erin, '2026-03-16', jsonb_build_array(
    jsonb_build_object('start', pg_temp.epoch('2026-03-16 09:00:00-07'), 'end', pg_temp.epoch('2026-03-16 10:00:00-07'),
      'type', 'verified', 'project_id', '00000000-0000-4000-8000-0000000000f2', 'counted', true, 'flagged', false),
    jsonb_build_object('start', pg_temp.epoch('2026-03-16 10:00:00-07'), 'end', pg_temp.epoch('2026-03-16 11:00:00-07'),
      'type', 'verified', 'project_id', '00000000-0000-4000-8000-0000000000f1', 'counted', true, 'flagged', false),
    jsonb_build_object('start', pg_temp.epoch('2026-03-16 11:00:00-07'), 'end', pg_temp.epoch('2026-03-16 11:20:00-07'),
      'type', 'idle', 'project_id', '00000000-0000-4000-8000-0000000000f1', 'counted', true, 'flagged', true)
  )), 3, 'rebuild: replaces the day''s segments with the edited projects');
select is(
  (select (project_id::text, excluded)::text from public.time_segments where user_id = :erin and type = 'idle'),
  '(00000000-0000-4000-8000-0000000000f1,t)', 'rebuild: the exclusion is applied on top of the edited segments');

-- Locked weeks -----------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is(public.submit_timesheet((select id from ts)), 'submitted', 'submit: the employee submits the week');
select throws_ok($$ select public.reassign_my_time('2026-03-17 09:00:00-07', '2026-03-17 10:00:00-07', '00000000-0000-4000-8000-0000000000f2') $$,
  '55000', 'timesheet_submitted', 'locked: a submitted week is under review');
select pg_temp.act_as_postgres();
update public.timesheets set status = 'approved' where id = (select id from ts);
select pg_temp.act_as(:erin);
select throws_ok($$ select public.reassign_my_time('2026-03-17 09:00:00-07', '2026-03-17 10:00:00-07', '00000000-0000-4000-8000-0000000000f2') $$,
  '55000', 'timesheet_locked', 'locked: nor an approved one');
select pg_temp.act_as_postgres();
update public.timesheets set status = 'returned' where id = (select id from ts);
select pg_temp.act_as(:erin);
select lives_ok($$ select public.reassign_my_time('2026-03-17 09:00:00-07', '2026-03-17 10:00:00-07', '00000000-0000-4000-8000-0000000000f2') $$,
  'returned: a returned week is theirs again');
select is((select count(*)::int from public.timesheet_edits where kind = 'employee_project'), 5,
  'returned: five employee edits in all (the refused ones left none)');

-- A week without a row yet --------------------------------------------------------------------

select is((select count(*)::int from public.timesheets where user_id = :erin and period_start = '2026-03-23'), 0, 'new week: no timesheet yet');
select lives_ok($$ select public.reassign_my_time('2026-03-23 09:00:00-07', '2026-03-23 10:00:00-07', '00000000-0000-4000-8000-0000000000f2') $$,
  'new week: re-assigning opens it');
select is((select status from public.timesheets where user_id = :erin and period_start = '2026-03-23'), 'draft',
  'new week: as a draft');

select * from finish();
rollback;
