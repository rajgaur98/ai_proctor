begin;
create extension if not exists pgtap with schema extensions;

select plan(136);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set mia '''00000000-0000-4000-8000-0000000000d1'''
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

-- Read as the database owner: dirty_days is closed to the API roles.
create function pg_temp.dirty(uid uuid) returns text
language sql security definer as $$
  select coalesce(string_agg(day::text, ',' order by day), '') from public.dirty_days where user_id = uid
$$;

create function pg_temp.epoch(t timestamptz) returns bigint
language sql as $$ select extract(epoch from t)::bigint $$;

-- Audit rows of one action about one employee for one timesheet, read as the owner.
create function pg_temp.audited(act text, ts uuid) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log where action = act and metadata ->> 'timesheet_id' = ts::text
$$;

-- Notifications of one kind for one timesheet, read as the owner.
create function pg_temp.notified(uid uuid, k text, ts uuid) returns int
language sql security definer as $$
  select count(*)::int from public.notifications
  where user_id = uid and kind = k and payload ->> 'timesheet_id' = ts::text
$$;

-- Mia manages nobody involved here; she becomes Max's delegate below.
insert into auth.users (id, email) values (:mia, 'mia@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id)
values (:mia, :org, 'Mia Manager', 'mia@acme.test', 'manager', :ada);

-- Erin is in America/Los_Angeles; the week of Monday 16 March 2026 is daylight time (-07).
-- Monday: verified 09:00-11:00 (Website revamp), idle 11:00-11:20, unverified 11:20-11:45,
-- verified 11:45-13:00. Tuesday: verified 09:00-12:00.
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, project_id, counted, flagged)
values
  (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 11:00:00-07', 'verified', :revamp, true, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07', 'idle', :revamp, true, true),
  (:org, :erin, '2026-03-16', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07', 'unverified', :revamp, true, true),
  (:org, :erin, '2026-03-16', '2026-03-16 11:45:00-07', '2026-03-16 13:00:00-07', 'verified', :revamp, true, false),
  (:org, :erin, '2026-03-17', '2026-03-17 09:00:00-07', '2026-03-17 12:00:00-07', 'verified', :revamp, true, false);

-- Creating the week ----------------------------------------------------------------------

select pg_temp.act_as(:erin);
create temp table ts as select public.ensure_timesheet(:erin, '2026-03-16') as id;
grant select on ts to authenticated;
select ok((select id from ts) is not null, 'ensure: an employee gets a draft for the week');
select is((select status from public.timesheets where id = (select id from ts)), 'draft', 'ensure: it starts as a draft');
select is(public.ensure_timesheet(:erin, '2026-03-16'), (select id from ts), 'ensure: asking again returns the same week');
select throws_ok($$ select public.ensure_timesheet('00000000-0000-4000-8000-0000000000c1', '2026-03-17') $$,
  '22023', 'invalid_week', 'ensure: a day that is not a week start is refused (Monday by default)');
select throws_ok($$ select public.ensure_timesheet('00000000-0000-4000-8000-0000000000c1', null) $$,
  '22023', 'invalid_week', 'ensure: a week is required');
select pg_temp.act_as(:lucas);
select throws_ok($$ select public.ensure_timesheet('00000000-0000-4000-8000-0000000000c1', '2026-03-16') $$,
  '42501', 'user_not_found', 'ensure: a peer cannot open Erin''s week');
select is((select count(*)::int from public.timesheets), 0, 'RLS: a peer sees no timesheets');
select is(public.can_decide_timesheet(:erin), false, 'can_decide: a peer cannot');

-- Submitting ------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select is((select count(*)::int from public.timesheets), 1, 'RLS: the direct manager reads the week');
select throws_ok(format($$ select public.submit_timesheet(%L) $$, (select id from ts)),
  '42501', 'not_your_timesheet', 'submit: only the employee submits');
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '42501', 'not_the_manager', 'approve: nobody approves their own week');
create temp table future as select public.ensure_timesheet(:erin, '2027-03-15') as id;
grant select on future to authenticated;
select throws_ok(format($$ select public.submit_timesheet(%L) $$, (select id from future)),
  '22023', 'week_in_future', 'submit: not a week that has not started');
select is(public.submit_timesheet((select id from ts)), 'submitted', 'submit: draft to submitted');
select is(
  (select (status, submitted_at is not null, approved_at is null)::text from public.timesheets where id = (select id from ts)),
  '(submitted,t,t)', 'submit: status and time recorded');
select throws_ok(format($$ select public.submit_timesheet(%L) $$, (select id from ts)),
  '55000', 'not_submittable', 'submit: not twice');
select is(pg_temp.audited('timesheet.submitted', (select id from ts)), 1, 'audit: submission');

-- Who may approve -------------------------------------------------------------------------

select pg_temp.act_as(:lucas);
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '42501', 'timesheet_not_found', 'approve: a peer cannot');
select pg_temp.act_as(:mia);
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '42501', 'timesheet_not_found', 'approve: an unrelated manager cannot');
select pg_temp.act_as(:ada);
select is((select count(*)::int from public.timesheets), 2, 'RLS: the owner can read (view only), this week and the future one');
select is(public.can_decide_timesheet(:erin), false, 'can_decide: an owner who is not the manager cannot');
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '42501', 'not_the_manager', 'approve: an admin or owner who is not the manager cannot (TS-12)');
select throws_ok(format($$ select public.return_timesheet(%L, 'No') $$, (select id from ts)),
  '42501', 'not_the_manager', 'return: nor can they return');
select throws_ok(format($$ select public.edit_segment(%L, 'keep', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07') $$, (select id from ts)),
  '42501', 'not_the_manager', 'edit: nor edit');
select pg_temp.act_as(:max);
select is(public.can_decide_timesheet(:erin), true, 'can_decide: the direct manager can');
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '55000', 'undecided_flagged', 'approve: every flagged segment needs a decision first');

-- Decisions and edits on flagged time ------------------------------------------------------

select is(
  (select jsonb_agg(f.decision order by f.start_at)::text from public.timesheet_flagged_segments(:erin, '2026-03-16', '2026-03-22') f),
  '[null, null]', 'flagged segments: two, both undecided');
select is(
  (select worked_s::text || '/' || flagged_s || '/' || excluded_s from public.timesheet_totals('2026-03-16', '2026-03-22') where user_id = :erin),
  '25200/2700/0', 'totals: 7 h worked, 45 min flagged (raw seconds), nothing excluded');

select lives_ok(format($$ select public.edit_segment(%L, 'keep', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07') $$, (select id from ts)),
  'keep: the manager keeps the idle segment, no reason needed');
select throws_ok(format($$ select public.edit_segment(%L, 'exclude', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07') $$, (select id from ts)),
  '22023', 'invalid_reason', 'exclude: a reason is required (TS-13)');
select throws_ok(format($$ select public.edit_segment(%L, 'exclude', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07', null, '   ') $$, (select id from ts)),
  '22023', 'invalid_reason', 'exclude: a blank reason is no reason');
select throws_ok(format($$ select public.edit_segment(%L, 'exclude', '2026-03-16 09:00:00-07', '2026-03-16 11:00:00-07', null, 'Not worked') $$, (select id from ts)),
  '22023', 'not_flagged', 'exclude: only flagged time can be excluded (TS-02)');
select throws_ok(format($$ select public.edit_segment(%L, 'exclude', '2026-03-23 11:20:00-07', '2026-03-23 11:45:00-07', null, 'Next week') $$, (select id from ts)),
  '22023', 'outside_week', 'exclude: only inside the week');
select throws_ok(format($$ select public.edit_segment(%L, 'delete', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07', null, 'x') $$, (select id from ts)),
  '22023', 'invalid_kind', 'edit: unknown kinds are refused');
select throws_ok(format($$ select public.edit_segment(%L, 'exclude', '2026-03-16 11:45:00-07', '2026-03-16 11:20:00-07', null, 'x') $$, (select id from ts)),
  '22023', 'invalid_range', 'edit: the end follows the start');
select is((select count(*)::int from public.timesheet_edits), 1, 'edit: refused edits leave nothing behind');

select lives_ok(format($$ select public.edit_segment(%L, 'exclude', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07', null, '  Idle before lunch, not work  ') $$, (select id from ts)),
  'exclude: the manager excludes the unverified segment with a reason');
select is(
  (select (excluded, excluded_reason, excluded_by)::text from public.time_segments where user_id = :erin and type = 'unverified'),
  '(t,"Idle before lunch, not work",00000000-0000-4000-8000-0000000000b1)', 'exclude: the stored segment is excluded, reason trimmed');
select is(
  (select jsonb_agg(f.decision order by f.start_at)::text from public.timesheet_flagged_segments(:erin, '2026-03-16', '2026-03-22') f),
  '["keep", "exclude"]', 'flagged segments: the manager sees both decisions');
select is(
  (select worked_s::text || '/' || flagged_s || '/' || excluded_s from public.timesheet_totals('2026-03-16', '2026-03-22') where user_id = :erin),
  '23700/1200/1500', 'totals: excluded time leaves worked and flagged, and shows as excluded');
select throws_ok(format($$ select public.edit_segment(%L, 'keep', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07') $$, (select id from ts)),
  '55000', 'already_excluded', 'keep: undoing an exclusion goes through include, with a reason');
select lives_ok(format($$ select public.edit_segment(%L, 'include', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07', null, 'Client confirmed the call') $$, (select id from ts)),
  'include: the manager puts the time back');
select is((select excluded from public.time_segments where user_id = :erin and type = 'unverified'), false,
  'include: the segment counts again');
select lives_ok(format($$ select public.edit_segment(%L, 'exclude', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07', null, 'Changed my mind') $$, (select id from ts)),
  'exclude: and can exclude again');
select is((select excluded from public.time_segments where user_id = :erin and type = 'unverified'), true,
  'exclude: latest decision wins');
select is((select excluded from public.time_segments where user_id = :erin and type = 'idle'), false,
  'keep: the kept segment stays counted');
select pg_temp.act_as_postgres();
select is(pg_temp.audited('timesheet.edited', (select id from ts)), 3, 'audit: exclude, include, exclude (keep is not an edit)');
select is(
  (select metadata ->> 'reason' from public.audit_log where action = 'timesheet.edited' and metadata ->> 'kind' = 'exclude' order by id limit 1),
  'Idle before lunch, not work', 'audit: the reason is recorded');
select is(pg_temp.notified(:erin, 'timesheet.edited', (select id from ts)), 3, 'notify: the employee is told of each edit');

-- What the employee sees -------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.timesheet_edits), 3, 'RLS: the employee sees the edits with their reasons, not the keep decision');
select is((select count(*)::int from public.timesheet_edits where kind = 'keep'), 0, 'RLS: keep decisions are hidden from the employee');
select is(
  (select jsonb_agg(f.decision order by f.start_at)::text from public.timesheet_flagged_segments(:erin, '2026-03-16', '2026-03-22') f),
  '[null, null]', 'flagged segments: the employee gets no decisions');
select is(
  (select jsonb_agg(f.excluded order by f.start_at)::text from public.timesheet_flagged_segments(:erin, '2026-03-16', '2026-03-22') f),
  '[false, true]', 'flagged segments: but sees what was excluded');
select throws_ok($$ insert into public.timesheet_edits (org_id, timesheet_id, user_id, kind, start_at, end_at, reason)
  select org_id, id, user_id, 'exclude', now() - interval '1 hour', now(), 'Sneaky' from public.timesheets $$,
  '42501', null, 'no direct client writes: edits');
select throws_ok($$ update public.timesheets set status = 'approved' $$, '42501', null, 'no direct client writes: timesheets');
select throws_ok(format($$ select public.edit_segment(%L, 'exclude', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07', null, 'Mine') $$, (select id from ts)),
  '42501', 'not_the_manager', 'edit: the employee cannot edit their own week');
select pg_temp.act_as_postgres();
select throws_ok($$ update public.timesheet_edits set reason = 'Changed' $$, '42501', 'timesheet_edits_are_append_only',
  'edits are append-only');

-- Project edits survive a rebuild ------------------------------------------------------------

delete from public.dirty_days;
select pg_temp.act_as(:max);
select throws_ok(format($$ select public.edit_segment(%L, 'project', '2026-03-16 09:00:00-07', '2026-03-16 11:00:00-07', %L, null) $$,
  (select id from ts), '00000000-0000-4000-8000-0000000000f2'),
  '22023', 'invalid_reason', 'project: a reason is required');
select throws_ok(format($$ select public.edit_segment(%L, 'project', '2026-03-16 09:00:00-07', '2026-03-16 11:00:00-07', %L, 'Wrong project') $$,
  (select id from ts), gen_random_uuid()),
  '22023', 'project_not_allowed', 'project: it has to be one of the org''s projects');
select throws_ok(format($$ select public.edit_segment(%L, 'project', '2026-03-18 09:00:00-07', '2026-03-18 11:00:00-07', %L, 'Nothing there') $$,
  (select id from ts), '00000000-0000-4000-8000-0000000000f2'),
  '22023', 'no_segments', 'project: there has to be time to move');
select lives_ok(format($$ select public.edit_segment(%L, 'project', '2026-03-16 09:00:00-07', '2026-03-16 11:00:00-07', %L, 'Was internal work') $$,
  (select id from ts), '00000000-0000-4000-8000-0000000000f2'),
  'project: the manager changes the project of a span');
select pg_temp.act_as_postgres();
select is(pg_temp.dirty(:erin), '2026-03-16', 'project: marks the day dirty so the next rebuild applies it');
select is(public.segment_inputs(:erin, '2026-03-16') -> 'input' -> 'projectEdits',
  jsonb_build_array(jsonb_build_object('start', pg_temp.epoch('2026-03-16 09:00:00-07'),
    'end', pg_temp.epoch('2026-03-16 11:00:00-07'), 'projectId', '00000000-0000-4000-8000-0000000000f2')),
  'segment_inputs: the edit reaches buildSegments as projectEdits');
select is(public.segment_inputs(:erin, '2026-03-17') -> 'input' -> 'projectEdits', '[]'::jsonb,
  'segment_inputs: only the edits that touch the day');

-- A rebuild replaces the rows (new ids, slightly different edges); the exclusion is applied again.
select is(
  internal.replace_day_segments(:erin, '2026-03-16', jsonb_build_array(
    jsonb_build_object('start', pg_temp.epoch('2026-03-16 09:00:00-07'), 'end', pg_temp.epoch('2026-03-16 11:00:00-07'),
      'type', 'verified', 'project_id', '00000000-0000-4000-8000-0000000000f2', 'counted', true, 'flagged', false),
    jsonb_build_object('start', pg_temp.epoch('2026-03-16 11:00:00-07'), 'end', pg_temp.epoch('2026-03-16 11:20:00-07'),
      'type', 'idle', 'project_id', '00000000-0000-4000-8000-0000000000f1', 'counted', true, 'flagged', true),
    jsonb_build_object('start', pg_temp.epoch('2026-03-16 11:20:00-07'), 'end', pg_temp.epoch('2026-03-16 11:50:00-07'),
      'type', 'unverified', 'project_id', '00000000-0000-4000-8000-0000000000f1', 'counted', true, 'flagged', true),
    jsonb_build_object('start', pg_temp.epoch('2026-03-16 11:50:00-07'), 'end', pg_temp.epoch('2026-03-16 13:00:00-07'),
      'type', 'verified', 'project_id', '00000000-0000-4000-8000-0000000000f1', 'counted', true, 'flagged', false)
  )), 4, 'rebuild: replaces the day''s segments');
select is(
  (select jsonb_agg(excluded order by start_at)::text from public.time_segments where user_id = :erin and day = '2026-03-16'),
  '[false, false, true, false]', 'rebuild: the exclusion survives, on the overlapping flagged segment only');
select is(
  (select excluded_reason from public.time_segments where user_id = :erin and day = '2026-03-16' and type = 'unverified'),
  'Changed my mind', 'rebuild: with the latest reason');
select is(pg_temp.dirty(:erin), '', 'rebuild: clears the dirty mark');

-- Manager adds and adjusts time ---------------------------------------------------------------

select pg_temp.act_as(:erin);
create temp table pending as
select public.request_manual_entry('2026-03-18 14:00:00-07', '2026-03-18 15:00:00-07', null, 'Client visit') as id;
grant select on pending to authenticated;
select pg_temp.act_as(:max);
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '55000', 'pending_entries', 'approve: a pending manual entry in the week blocks it (server side)');
select throws_ok(format($$ select public.adjust_time(%L, '2026-03-17 14:00:00-07', '2026-03-17 15:00:00-07', %L, '   ') $$,
  (select id from ts), '00000000-0000-4000-8000-0000000000f1'),
  '22023', 'invalid_reason', 'adjust: a reason is required');
select throws_ok(format($$ select public.adjust_time(%L, '2026-03-17 14:00:00-07', '2026-03-17 15:00:00-07', %L, 'x', %L) $$,
  (select id from ts), '00000000-0000-4000-8000-0000000000f1', gen_random_uuid()),
  '42501', 'entry_not_found', 'adjust: the entry has to be the employee''s');
select throws_ok(format($$ select public.adjust_time(%L, '2026-03-18 14:30:00-07', '2026-03-18 15:30:00-07', %L, 'Overlaps') $$,
  (select id from ts), '00000000-0000-4000-8000-0000000000f1'),
  '23P01', 'overlaps_manual_entry', 'adjust: added time cannot overlap another entry (TS-09)');
select throws_ok(format($$ select public.adjust_time(%L, '2026-03-23 14:00:00-07', '2026-03-23 15:00:00-07', %L, 'Next week') $$,
  (select id from ts), '00000000-0000-4000-8000-0000000000f1'),
  '22023', 'outside_week', 'adjust: only inside the week');
select pg_temp.act_as_postgres();
delete from public.dirty_days;
select pg_temp.act_as(:max);
create temp table added as
select public.adjust_time((select id from ts), '2026-03-17 14:00:00-07', '2026-03-17 15:30:00-07',
  '00000000-0000-4000-8000-0000000000f1', 'Call with the client, laptop closed') as id;
grant select on added to authenticated;
select is(
  (select (user_id, status, decided_by, project_id)::text from public.manual_entries where id = (select id from added)),
  '(00000000-0000-4000-8000-0000000000c1,approved,00000000-0000-4000-8000-0000000000b1,00000000-0000-4000-8000-0000000000f1)',
  'adjust: added time is an approved manual entry for the employee, decided by the manager');
select is((select (kind, reason, detail ->> 'entry_id' = (select id::text from added))::text from public.timesheet_edits where kind = 'adjust'),
  '(adjust,"Call with the client, laptop closed",t)', 'adjust: logged as an edit with its reason');
select pg_temp.act_as_postgres();
select is(pg_temp.dirty(:erin), '2026-03-17', 'adjust: marks the day dirty so the rebuild counts it');
select pg_temp.act_as(:max);
select lives_ok(format($$ select public.adjust_time(%L, '2026-03-18 14:30:00-07', '2026-03-18 15:30:00-07', null, 'Started later', %L) $$,
  (select id from ts), (select id from pending)),
  'adjust: the manager changes the times of a manual entry');
select is(
  (select (status, start_at, end_at, project_id is null)::text from public.manual_entries where id = (select id from pending)),
  '(pending,"2026-03-18 21:30:00+00","2026-03-18 22:30:00+00",t)', 'adjust: new times and project, the entry stays pending');
select is((select detail -> 'before' ->> 'start_at' from public.timesheet_edits where kind = 'adjust' and detail ->> 'entry_id' = (select id::text from pending)),
  '2026-03-18T21:00:00+00:00', 'adjust: the old times are kept in the edit');
select is(pg_temp.audited('timesheet.edited', (select id from ts)), 6, 'audit: the project edit and both adjustments, on top of the exclusions');
select pg_temp.act_as(:lucas);
select throws_ok(format($$ select public.adjust_time(%L, '2026-03-19 14:00:00-07', '2026-03-19 15:00:00-07', null, 'Peer') $$, (select id from ts)),
  '42501', 'timesheet_not_found', 'adjust: a peer cannot');
select pg_temp.act_as(:ada);
select throws_ok(format($$ select public.adjust_time(%L, '2026-03-19 14:00:00-07', '2026-03-19 15:00:00-07', null, 'Owner') $$, (select id from ts)),
  '42501', 'not_the_manager', 'adjust: an owner who is not the manager cannot');

-- Delegates return, the manager approves -------------------------------------------------------

select pg_temp.act_as_postgres();
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org, :max, :mia, current_date - 1, current_date + 3);
delete from public.dirty_days;
select pg_temp.act_as(:mia);
select is(public.can_decide_timesheet(:erin), true, 'can_decide: an active delegate can');
select throws_ok(format($$ select public.return_timesheet(%L, '  ') $$, (select id from ts)),
  '22023', 'invalid_comment', 'return: a comment is required');
select lives_ok(format($$ select public.return_timesheet(%L, '  Please add the Wednesday visit  ') $$, (select id from ts)),
  'return: the delegate returns the week with a comment');
select is(
  (select (status, comment, returned_at is not null)::text from public.timesheets where id = (select id from ts)),
  '(returned,"Please add the Wednesday visit",t)', 'return: status and trimmed comment recorded');
select throws_ok(format($$ select public.return_timesheet(%L, 'Again') $$, (select id from ts)),
  '55000', 'not_submitted', 'return: only a submitted week');
select pg_temp.act_as_postgres();
select is(pg_temp.dirty(:erin), '2026-03-16,2026-03-17,2026-03-18,2026-03-19,2026-03-20,2026-03-21,2026-03-22',
  'return: marks the week''s days dirty');
select is(pg_temp.audited('timesheet.returned', (select id from ts)), 1, 'audit: return, with the comment');
select is(pg_temp.notified(:erin, 'timesheet.returned', (select id from ts)), 1, 'notify: the employee is told of the return');
select pg_temp.act_as(:erin);
select is((select payload ->> 'comment' from public.notifications where kind = 'timesheet.returned'), 'Please add the Wednesday visit',
  'notify: the comment is in the notification');
select is(public.submit_timesheet((select id from ts)), 'submitted', 'submit: a returned week goes back to submitted');
select pg_temp.act_as(:max);
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '55000', 'pending_entries', 'approve: still blocked by the pending entry');
select lives_ok(format($$ select public.decide_manual_entry(%L, true) $$, (select id from pending)),
  'the manager decides the pending entry');

select pg_temp.act_as_postgres();
delete from public.dirty_days;
select pg_temp.act_as(:max);
select lives_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)), 'approve: the direct manager approves');
select is(
  (select (status, approver_id, approved_at is not null)::text from public.timesheets where id = (select id from ts)),
  '(approved,00000000-0000-4000-8000-0000000000b1,t)', 'approve: approver and time recorded');
select is(pg_temp.audited('timesheet.approved', (select id from ts)), 1, 'audit: approval');

-- Locked ---------------------------------------------------------------------------------------

select pg_temp.act_as_postgres();
select is(
  (select array_agg(internal.day_locked(:erin, d::date) order by d)
   from generate_series('2026-03-15'::date, '2026-03-23'::date, interval '1 day') d),
  array[false, true, true, true, true, true, true, true, false], 'locked: the seven days of an approved week, not the days around');
select is(
  internal.replace_day_segments(:erin, '2026-03-16', '[]'::jsonb), null,
  'locked: a rebuild leaves an approved day alone');
select is((select count(*)::int from public.time_segments where user_id = :erin and day = '2026-03-16'), 4,
  'locked: and its segments stay');
select pg_temp.act_as(:erin);
select throws_ok($$ select public.request_manual_entry('2026-03-19 10:00:00-07', '2026-03-19 11:00:00-07', null, 'Late') $$,
  '55000', 'day_locked', 'locked: no manual entry into an approved week');
select throws_ok(format($$ select public.submit_timesheet(%L) $$, (select id from ts)),
  '55000', 'not_submittable', 'locked: nothing to submit');
select pg_temp.act_as(:max);
select throws_ok(format($$ select public.edit_segment(%L, 'keep', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07') $$, (select id from ts)),
  '55000', 'timesheet_locked', 'locked: no edits');
select throws_ok(format($$ select public.adjust_time(%L, '2026-03-19 14:00:00-07', '2026-03-19 15:00:00-07', null, 'Late') $$, (select id from ts)),
  '55000', 'timesheet_locked', 'locked: no adjustments');
select throws_ok(format($$ select public.return_timesheet(%L, 'Too late') $$, (select id from ts)),
  '55000', 'not_submitted', 'locked: no return, reopen first');
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '55000', 'not_submitted', 'locked: approve only once');

-- Reopen ---------------------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.reopen_timesheet(%L, 'Please') $$, (select id from ts)),
  '42501', 'not_the_manager', 'reopen: the employee cannot');
select pg_temp.act_as(:ada);
select throws_ok(format($$ select public.reopen_timesheet(%L, 'Please') $$, (select id from ts)),
  '42501', 'not_the_manager', 'reopen: an admin who is not the manager cannot');
select pg_temp.act_as(:max);
select throws_ok(format($$ select public.reopen_timesheet(%L, '  ') $$, (select id from ts)),
  '22023', 'invalid_reason', 'reopen: a reason is required');
select pg_temp.act_as_postgres();
delete from public.dirty_days;
select pg_temp.act_as(:max);
select lives_ok(format($$ select public.reopen_timesheet(%L, 'Forgot the Friday visit') $$, (select id from ts)),
  'reopen: the manager reopens the approved week');
select is(
  (select (status, approver_id is null, approved_at is null)::text from public.timesheets where id = (select id from ts)),
  '(submitted,t,t)', 'reopen: back to submitted, approval cleared');
select throws_ok(format($$ select public.reopen_timesheet(%L, 'Again') $$, (select id from ts)),
  '55000', 'not_approved', 'reopen: only an approved week');
select pg_temp.act_as_postgres();
select is(pg_temp.dirty(:erin), '2026-03-16,2026-03-17,2026-03-18,2026-03-19,2026-03-20,2026-03-21,2026-03-22',
  'reopen: marks the week''s days dirty again');
select is(pg_temp.audited('timesheet.reopened', (select id from ts)), 1, 'audit: reopen');
select is((select metadata ->> 'reason' from public.audit_log where action = 'timesheet.reopened' order by id desc limit 1),
  'Forgot the Friday visit', 'audit: with the reason');
select is(pg_temp.notified(:erin, 'timesheet.reopened', (select id from ts)), 1, 'notify: the employee is told of the reopen');
select is(internal.day_locked(:erin, '2026-03-16'), false, 'reopen: the days unlock');
select ok(internal.replace_day_segments(:erin, '2026-03-16', '[]'::jsonb) is not null, 'reopen: rebuilds work again');

-- Notifications ------------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.notifications where read_at is null), 8, 'notifications: the employee sees their own');
select is(public.mark_notifications_read(), 8, 'notifications: marked read');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.notifications), 0, 'notifications: a peer sees none of them');
select pg_temp.act_as(:max);
select is((select count(*)::int from public.notifications), 0, 'notifications: nor does the manager');

-- Approval not required, and no manager ------------------------------------------------------------

select pg_temp.act_as_postgres();
update public.users set manager_id = null where id = :max;
select pg_temp.act_as(:max);
create temp table nomgr_ts as select public.ensure_timesheet(:max, '2026-03-16') as id;
grant select on nomgr_ts to authenticated;
select throws_ok(format($$ select public.submit_timesheet(%L) $$, (select id from nomgr_ts)),
  '55000', 'no_manager', 'submit: someone other than the owner without a manager has nobody to approve');
select pg_temp.act_as_postgres();
update public.users set manager_id = :ada where id = :max;
select pg_temp.act_as(:ada);
create temp table owner_ts as select public.ensure_timesheet(:ada, '2026-03-16') as id;
grant select on owner_ts to authenticated;
select is(public.submit_timesheet((select id from owner_ts)), 'approved', 'submit: the owner, top of the org, is approved at once (TS-16)');
select is(
  (select (status, approver_id is null, approved_at is not null)::text from public.timesheets where id = (select id from owner_ts)),
  '(approved,t,t)', 'auto-approve: approved on submit');
select is(pg_temp.audited('timesheet.auto_approved', (select id from owner_ts)), 1, 'audit: auto-approval');
select pg_temp.act_as_postgres();
select is(internal.day_locked(:ada, '2026-03-18'), true, 'auto-approve: the week is locked like any approved week');

-- Week start ---------------------------------------------------------------------------------

select is(internal.week_start(:org, '2026-03-18'), '2026-03-16'::date, 'week start: Monday by default');
update public.orgs set policy = policy || '{"week_start": "sunday"}' where id = :org;
select is(internal.week_start(:org, '2026-03-18'), '2026-03-15'::date, 'week start: sunday');
select is(internal.week_start(:org, '2026-03-15'), '2026-03-15'::date, 'week start: a week start maps to itself');
update public.orgs set policy = policy || '{"week_start": "Wednesday"}' where id = :org;
select is(internal.week_start(:org, '2026-03-18'), '2026-03-18'::date, 'week start: case is ignored, wednesday');
select is(internal.week_start(:org, '2026-03-17'), '2026-03-11'::date, 'week start: the day before it belongs to the previous week');
update public.orgs set policy = policy || '{"week_start": "someday"}' where id = :org;
select is(internal.week_start(:org, '2026-03-18'), '2026-03-16'::date, 'week start: an unknown value is Monday');
update public.orgs set policy = policy || '{"week_start": "sunday"}' where id = :org;
select pg_temp.act_as(:lucas);
select throws_ok($$ select public.ensure_timesheet('00000000-0000-4000-8000-0000000000c2', '2026-03-16') $$,
  '22023', 'invalid_week', 'week start: a Monday is no longer a week start');
select lives_ok($$ select public.ensure_timesheet('00000000-0000-4000-8000-0000000000c2', '2026-03-15') $$,
  'week start: a Sunday is');
select pg_temp.act_as(:erin);
select is(public.ensure_timesheet(:erin, '2026-03-16'), (select id from ts), 'week start: an existing week keeps the start it was created with');
select throws_ok($$ select public.ensure_timesheet('00000000-0000-4000-8000-0000000000c1', '2026-03-22') $$,
  '22023', 'invalid_week', 'week start: a new week cannot overlap an existing one');

select * from finish();
rollback;
