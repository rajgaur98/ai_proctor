-- #254 part 1: tasks under projects (PRJ-05) and work notes (TS-24, TS-25).
begin;
create extension if not exists pgtap with schema extensions;

select plan(69);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
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

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

create function pg_temp.epoch(t timestamptz) returns bigint
language sql as $$ select extract(epoch from t)::bigint $$;

-- Read as the database owner: the audit log is closed to employees.
create function pg_temp.audited(act text, target uuid) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log where action = act and target_user_id = target
$$;

create function pg_temp.task(p_name text) returns uuid
language sql security definer as $$ select id from public.project_tasks where name = p_name $$;

-- Tasks: who manages them ---------------------------------------------------------------------

select has_table('public', 'project_tasks', 'project_tasks exists');

select pg_temp.act_as(:erin);
select throws_ok($$ select public.save_task(null, '00000000-0000-4000-8000-0000000000f1', 'Design') $$,
  '42501', 'manager_or_admin_only', 'save_task: an employee cannot add a task');
select throws_ok($$ insert into public.project_tasks (org_id, project_id, name, billable)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000f1', 'Sneaky', true) $$,
  '42501', null, 'project_tasks: no direct writes');

select pg_temp.act_as(:max);
select lives_ok($$ select public.save_task(null, '00000000-0000-4000-8000-0000000000f1', '  Design  ') $$,
  'save_task: a manager adds a task (name trimmed)');
select lives_ok($$ select public.save_task(null, '00000000-0000-4000-8000-0000000000f1', 'Testing', false) $$,
  'save_task: with its own billable flag');
select pg_temp.act_as(:ada);
select lives_ok($$ select public.save_task(null, '00000000-0000-4000-8000-0000000000f2', 'Hiring') $$,
  'save_task: an admin adds one too');
select lives_ok($$ select public.save_task(null, '00000000-0000-4000-8000-0000000000f1', 'Old work') $$,
  'save_task: a task to archive');

select is((select billable from public.project_tasks where name = 'Design'), true,
  'billable default: a billable project''s task is billable');
select is((select billable from public.project_tasks where name = 'Hiring'), false,
  'billable default: a non-billable project''s task is not');
select is((select billable from public.project_tasks where name = 'Testing'), false,
  'billable: an explicit flag wins over the project''s');
select is((select array_agg(name order by sort_order) from public.project_tasks where project_id = :revamp),
  array['Design', 'Testing', 'Old work'], 'sort order: new tasks go last');

select throws_ok($$ select public.save_task(null, '00000000-0000-4000-8000-0000000000f1', 'design') $$,
  '23505', 'name_taken', 'save_task: names are unique per project, ignoring case');
select lives_ok($$ select public.save_task(null, '00000000-0000-4000-8000-0000000000f2', 'Design') $$,
  'save_task: the same name on another project is fine');
select throws_ok($$ select public.save_task(null, '00000000-0000-4000-8000-0000000000f1', '   ') $$,
  '22023', 'invalid_name', 'save_task: a name is required');
select throws_ok($$ select public.save_task(null, gen_random_uuid(), 'Ghost') $$,
  '42501', 'project_not_found', 'save_task: an unknown project');
select throws_ok(format($$ select public.save_task(%L, '00000000-0000-4000-8000-0000000000f2', 'Moved') $$,
    pg_temp.task('Old work')),
  '42501', 'task_not_found', 'save_task: a task never moves to another project');

select lives_ok(format($$ select public.save_task(%L, '00000000-0000-4000-8000-0000000000f1', 'Old work', null, true) $$,
    pg_temp.task('Old work')),
  'save_task: archive');
select is((select archived::text || '/' || billable::text from public.project_tasks where name = 'Old work'),
  'true/true', 'archive: kept, billable unchanged when not given');
select lives_ok(format($$ select public.save_task(%L, '00000000-0000-4000-8000-0000000000f1', 'Design work') $$,
    pg_temp.task('Design')),
  'save_task: rename');

select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.project_tasks), 5, 'RLS: everyone in the org reads the task names');

-- Time carries a task -------------------------------------------------------------------------

-- Erin (America/Los_Angeles) asks for time on Website revamp's Design work task.
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.request_manual_entry('2026-03-16 14:00:00-07', '2026-03-16 15:00:00-07',
    '00000000-0000-4000-8000-0000000000f1', 'Offline', %L) $$, pg_temp.task('Old work')),
  '22023', 'task_not_allowed', 'request: not an archived task');
select throws_ok(format($$ select public.request_manual_entry('2026-03-16 14:00:00-07', '2026-03-16 15:00:00-07',
    '00000000-0000-4000-8000-0000000000f1', 'Offline', %L) $$, pg_temp.task('Hiring')),
  '22023', 'task_not_allowed', 'request: not another project''s task');
select throws_ok(format($$ select public.request_manual_entry('2026-03-16 14:00:00-07', '2026-03-16 15:00:00-07',
    null, 'Offline', %L) $$, pg_temp.task('Design work')),
  '22023', 'task_not_allowed', 'request: no task without a project');
select throws_ok(format($$ select public.request_manual_entry('2026-03-16 14:00:00-07', '2026-03-16 15:00:00-07',
    '00000000-0000-4000-8000-0000000000f1', 'Offline', %L, %L) $$, pg_temp.task('Design work'), repeat('x', 2001)),
  '22023', 'invalid_note', 'request: a work note is at most 2,000 characters');

create temp table e1 as
  select public.request_manual_entry('2026-03-16 14:00:00-07', '2026-03-16 15:00:00-07',
    '00000000-0000-4000-8000-0000000000f1', 'Offline at the client', pg_temp.task('Design work'),
    '  Wireframes for the checkout  ') as id;
grant select on e1 to authenticated;
select is((select task_id::text || '|' || note from public.manual_entries where id = (select id from e1)),
  pg_temp.task('Design work')::text || '|Wireframes for the checkout', 'request: the task and the trimmed note are stored');

-- Max approves it; the entry's task reaches buildSegments.
select pg_temp.act_as(:max);
select public.decide_manual_entry((select id from e1), true);
select pg_temp.act_as_postgres();
select is(public.segment_inputs(:erin, '2026-03-16') -> 'input' -> 'manualEntries',
  jsonb_build_array(jsonb_build_object('start', pg_temp.epoch('2026-03-16 14:00:00-07'),
    'end', pg_temp.epoch('2026-03-16 15:00:00-07'), 'projectId', :revamp::uuid,
    'taskId', pg_temp.task('Design work'))),
  'segment_inputs: the entry''s task goes in as taskId');

-- The rebuild writes the task with the segment.
select internal.replace_day_segments(:erin, '2026-03-16', jsonb_build_array(
  jsonb_build_object('start', pg_temp.epoch('2026-03-16 09:00:00-07'), 'end', pg_temp.epoch('2026-03-16 11:00:00-07'),
    'type', 'verified', 'project_id', :revamp::uuid, 'counted', true, 'flagged', false),
  jsonb_build_object('start', pg_temp.epoch('2026-03-16 14:00:00-07'), 'end', pg_temp.epoch('2026-03-16 15:00:00-07'),
    'type', 'manual', 'project_id', :revamp::uuid, 'task_id', pg_temp.task('Design work'),
    'counted', true, 'flagged', false)));
select is((select string_agg(type || ':' || coalesce(task_id::text, '-'), ',' order by start_at)
           from public.time_segments where user_id = :erin and day = '2026-03-16'),
  'verified:-,manual:' || pg_temp.task('Design work')::text, 'replace_day_segments: stores each segment''s task');

select pg_temp.act_as(:erin);
select is((select task_id from public.timesheet_breakdown(:erin, '2026-03-16', '2026-03-22') where type = 'manual'),
  pg_temp.task('Design work'), 'timesheet_breakdown: seconds by task');

-- The manager's project edit and the employee's re-assignment set a task.
create temp table ts as select public.ensure_timesheet(:erin, '2026-03-16') as id;
grant select on ts to authenticated;
select throws_ok(format($$ select public.reassign_my_time('2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07',
    '00000000-0000-4000-8000-0000000000f1', null, %L) $$, pg_temp.task('Hiring')),
  '22023', 'task_not_allowed', 'reassign: the task must be the project''s');
select lives_ok(format($$ select public.reassign_my_time('2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07',
    '00000000-0000-4000-8000-0000000000f1', null, %L) $$, pg_temp.task('Testing')),
  'reassign: the employee tags tracked time with a task');
select pg_temp.act_as(:max);
select lives_ok(format($$ select public.edit_segment(%L, 'project', '2026-03-16 10:00:00-07', '2026-03-16 11:00:00-07',
    '00000000-0000-4000-8000-0000000000f1', 'Was design', %L) $$, (select id from ts), pg_temp.task('Design work')),
  'edit_segment: the manager moves time to a task');
select throws_ok(format($$ select public.edit_segment(%L, 'project', '2026-03-16 10:00:00-07', '2026-03-16 11:00:00-07',
    '00000000-0000-4000-8000-0000000000f1', 'Old', %L) $$, (select id from ts), pg_temp.task('Old work')),
  '22023', 'task_not_allowed', 'edit_segment: not an archived task');
select pg_temp.act_as_postgres();
select is(
  (select jsonb_agg(e -> 'taskId' order by ord) from jsonb_array_elements(
     public.segment_inputs(:erin, '2026-03-16') -> 'input' -> 'projectEdits') with ordinality as t(e, ord)),
  jsonb_build_array(pg_temp.task('Testing'), pg_temp.task('Design work')),
  'segment_inputs: both edits carry their task, oldest first');

select pg_temp.act_as(:max);
select throws_ok(format($$ select public.adjust_time(%L, '2026-03-17 14:00:00-07', '2026-03-17 15:00:00-07',
    '00000000-0000-4000-8000-0000000000f2', 'Called in', null, %L) $$, (select id from ts), pg_temp.task('Design work')),
  '22023', 'task_not_allowed', 'adjust_time: the task must be the project''s');
select lives_ok(format($$ select public.adjust_time(%L, '2026-03-17 14:00:00-07', '2026-03-17 15:00:00-07',
    '00000000-0000-4000-8000-0000000000f2', 'Called in', null, %L) $$, (select id from ts), pg_temp.task('Hiring')),
  'adjust_time: the manager adds time with a task');
select is((select task_id from public.manual_entries where user_id = :erin and start_at = '2026-03-17 14:00:00-07'),
  pg_temp.task('Hiring'), 'adjust_time: the entry has the task');

-- Export: task column data ---------------------------------------------------------------------

select is(
  (select (r ->> 'task') || '/' || (r ->> 'billable') || '/' || coalesce(r ->> 'note', '-')
   from jsonb_array_elements(public.timesheet_export_rows('2026-03-16', '2026-03-16', 'segments',
     array[:erin]::uuid[]) -> 'rows') r
   where r ->> 'type' = 'manual'),
  'Design work/true/Wireframes for the checkout', 'export: a manual row has its task and its entry''s note');
-- A non-billable task on a billable project is not billable.
select pg_temp.act_as_postgres();
update public.time_segments set task_id = pg_temp.task('Testing')
where user_id = :erin and day = '2026-03-16' and type = 'verified';
select pg_temp.act_as(:max);
select is(
  (select (r ->> 'task') || '/' || (r ->> 'billable') || '/' || coalesce(r ->> 'note', '-')
   from jsonb_array_elements(public.timesheet_export_rows('2026-03-16', '2026-03-16', 'segments',
     array[:erin]::uuid[]) -> 'rows') r
   where r ->> 'type' = 'verified'),
  'Testing/false/-', 'export: the task''s billable flag wins; tracked time has no note');

-- Day notes: the employee writes ---------------------------------------------------------------

select pg_temp.act_as(:erin);
select lives_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', '2026-03-16', '  Sprint planning, checkout spec  ') $$,
  'day note: the employee writes their own');
select is((select note || '|' || (updated_by = :erin)::text from public.timesheet_day_notes where user_id = :erin and day = '2026-03-16'),
  'Sprint planning, checkout spec|true', 'day note: stored trimmed, with who wrote it');
select is((select timesheet_id from public.timesheet_day_notes where user_id = :erin and day = '2026-03-16'),
  (select id from ts), 'day note: belongs to the week''s timesheet');
select throws_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', '2026-03-17', repeat('x', 2001)) $$,
  '22023', 'invalid_note', 'day note: at most 2,000 characters');
select lives_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', '2026-03-17', repeat('x', 2000)) $$,
  'day note: 2,000 characters is fine');
select lives_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', '2026-03-17', '  ') $$,
  'day note: an empty note clears it');
select is((select count(*)::int from public.timesheet_day_notes where user_id = :erin and day = '2026-03-17'), 0,
  'day note: cleared');
select throws_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', current_date + 2, 'Later') $$,
  '22023', 'in_the_future', 'day note: not for a day that hasn''t come');
select throws_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c2', '2026-03-16', 'Not mine') $$,
  '42501', 'user_not_found', 'day note: not for someone the employee can''t see');
select is(pg_temp.audited('timesheet.note_edited', :erin), 0, 'audit: the employee''s own notes aren''t audit-logged');

-- The employee changes the note and task of their own entry.
select lives_ok(format($$ select public.update_manual_entry_details(%L, %L, 'Wireframes and review') $$,
    (select id from e1), pg_temp.task('Testing')),
  'entry details: the employee changes the task and note');
select is((select task_id::text || '|' || note from public.manual_entries where id = (select id from e1)),
  pg_temp.task('Testing')::text || '|Wireframes and review', 'entry details: stored');
select is(pg_temp.audited('manual_entry.details_changed', :erin), 1, 'audit: the employee''s task change is logged');

-- Day notes: who reads ---------------------------------------------------------------------------

select pg_temp.act_as(:max);
select is((select note from public.timesheet_day_notes where user_id = :erin and day = '2026-03-16'),
  'Sprint planning, checkout spec', 'RLS: the manager reads the note');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.timesheet_day_notes where user_id = :erin), 0,
  'RLS: a colleague doesn''t');
select pg_temp.act_as(:ada);
select is((select count(*)::int from public.timesheet_day_notes where user_id = :erin), 1, 'RLS: the owner reads it');
select throws_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', '2026-03-16', 'Owner edit', 'Fixing it') $$,
  '42501', 'not_the_manager', 'day note: an owner who isn''t the manager only reads');

-- The export carries the day notes of the days it covers.
select pg_temp.act_as(:max);
select is(public.timesheet_export_rows('2026-03-16', '2026-03-22', 'daily', array[:erin]::uuid[]) -> 'day_notes',
  jsonb_build_array(jsonb_build_object('user_id', :erin::uuid, 'day', '2026-03-16', 'note', 'Sprint planning, checkout spec')),
  'export: day_notes for the person-days in the rows');
select is(public.timesheet_export_rows('2026-03-16', '2026-03-22', 'daily', array[:lucas]::uuid[]) -> 'day_notes',
  '[]'::jsonb, 'export: none for people outside the filter');

-- The manager edits on the employee's behalf -----------------------------------------------------

select throws_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', '2026-03-16', 'Edited') $$,
  '22023', 'invalid_reason', 'day note: a manager''s change needs a reason');
select lives_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', '2026-03-16', 'Sprint planning', 'Shortened') $$,
  'day note: the manager changes it with a reason');
select is(pg_temp.audited('timesheet.note_edited', :erin), 1, 'audit: the manager''s change is logged');
select pg_temp.act_as_postgres();
select is((select metadata ->> 'before' || ' -> ' || (metadata ->> 'after') || ' (' || (metadata ->> 'reason') || ')'
           from public.audit_log where action = 'timesheet.note_edited'),
  'Sprint planning, checkout spec -> Sprint planning (Shortened)', 'audit: before, after and the reason');
select is((select count(*)::int from public.notifications where user_id = :erin and kind = 'timesheet.edited'
           and payload ->> 'kind' = 'note'), 1, 'notify: the employee is told');

-- Locked: submitted for the employee, approved for everyone ---------------------------------------

select pg_temp.act_as(:erin);
select public.submit_timesheet((select id from ts));
select throws_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', '2026-03-18', 'Late note') $$,
  '55000', 'timesheet_submitted', 'submitted: the employee waits for the review');
select throws_ok(format($$ select public.update_manual_entry_details(%L, null, 'Late') $$, (select id from e1)),
  '55000', 'timesheet_submitted', 'submitted: entry details too');

select pg_temp.act_as(:max);
select lives_ok(format($$ select public.update_manual_entry_details(%L, %L, 'Wireframes', 'Back to design') $$,
    (select id from e1), pg_temp.task('Design work')),
  'entry details: the manager changes them while reviewing, with a reason');
select is(pg_temp.audited('manual_entry.details_changed', :erin), 2, 'audit: the manager''s entry change is logged');
-- Every flagged segment and entry is decided, so the week can be approved.
select public.approve_timesheet((select id from ts));
select throws_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', '2026-03-16', 'After', 'Fix') $$,
  '55000', 'timesheet_locked', 'approved: locked for the manager');
select throws_ok(format($$ select public.update_manual_entry_details(%L, null, 'After', 'Fix') $$, (select id from e1)),
  '55000', 'timesheet_locked', 'approved: entry details locked');
select pg_temp.act_as(:erin);
select throws_ok($$ select public.save_day_note('00000000-0000-4000-8000-0000000000c1', '2026-03-16', 'After') $$,
  '55000', 'timesheet_locked', 'approved: locked for the employee');

select * from finish();
rollback;
