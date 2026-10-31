-- #263 (#254 part 4): the employee edits, splits, merges and duplicates their own manual
-- entries from the week's day list (TS-30).
begin;
create extension if not exists pgtap with schema extensions;

select plan(60);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
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

-- Read as the database owner: the audit log is closed to employees.
create function pg_temp.audited(act text, target uuid) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log where action = act and target_user_id = target
$$;
create function pg_temp.audit_meta(act text, target uuid) returns jsonb
language sql security definer as $$
  select metadata from public.audit_log where action = act and target_user_id = target
  order by id desc limit 1
$$;

-- Entries by name, so the tests read in words.
create table pg_temp.ids (name text primary key, id uuid);
grant select, insert on pg_temp.ids to authenticated;
create function pg_temp.id(p_name text) returns uuid
language sql as $$ select id from pg_temp.ids where name = p_name $$;
create function pg_temp.entry(p_name text) returns public.manual_entries
language sql security definer as $$
  select * from public.manual_entries where id = (select id from pg_temp.ids where name = p_name)
$$;
create function pg_temp.span(p_name text) returns text
language sql security definer as $$
  select to_char(start_at at time zone 'America/Los_Angeles', 'HH24:MI:SS') || '-'
    || to_char(end_at at time zone 'America/Los_Angeles', 'HH24:MI:SS') || ' ' || status
  from public.manual_entries where id = (select id from pg_temp.ids where name = p_name)
$$;

-- Erin (America/Los_Angeles, PST in February) asks for time in the week of 2 Feb 2026.
select pg_temp.act_as(:erin);
insert into pg_temp.ids values
  ('a', public.request_manual_entry('2026-02-02 10:00:00-08', '2026-02-02 12:00:00-08', :revamp,
    'Client workshop', null, 'Workshop notes')),
  ('c', public.request_manual_entry('2026-02-02 13:00:00-08', '2026-02-02 14:00:00-08', :revamp,
    'Offline', null, 'First half')),
  ('d', public.request_manual_entry('2026-02-02 14:00:00-08', '2026-02-02 14:30:00-08', null,
    'Offline', null, null)),
  ('e', public.request_manual_entry('2026-02-02 14:30:00-08', '2026-02-02 15:00:00-08', :revamp,
    'Train back', null, 'Second half')),
  ('r', public.request_manual_entry('2026-02-03 09:00:00-08', '2026-02-03 10:00:00-08', :revamp,
    'Will be rejected', null, null));

select pg_temp.act_as(:max);
select public.decide_manual_entry(pg_temp.id('a'), true, 'Fine');
select public.decide_manual_entry(pg_temp.id('r'), false);

-- Split ---------------------------------------------------------------------------------------

select throws_ok(format($$ select public.split_manual_entry(%L, '2026-02-02 11:00:00-08') $$, pg_temp.id('a')),
  '42501', 'not_your_entry', 'split: the manager can''t split the employee''s entry');
select pg_temp.act_as(:ada);
select throws_ok(format($$ select public.split_manual_entry(%L, '2026-02-02 11:00:00-08') $$, pg_temp.id('a')),
  '42501', 'not_your_entry', 'split: nor can the owner');
select pg_temp.act_as(:lucas);
select throws_ok(format($$ select public.split_manual_entry(%L, '2026-02-02 11:00:00-08') $$, pg_temp.id('a')),
  '42501', 'entry_not_found', 'split: a colleague doesn''t see it');

select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.split_manual_entry(%L, '2026-02-02 10:00:00-08') $$, pg_temp.id('a')),
  '22023', 'invalid_split', 'split: not at the start');
select throws_ok(format($$ select public.split_manual_entry(%L, '2026-02-02 12:00:00-08') $$, pg_temp.id('a')),
  '22023', 'invalid_split', 'split: not at the end');
select throws_ok(format($$ select public.split_manual_entry(%L, '2026-02-02 13:00:00-08') $$, pg_temp.id('a')),
  '22023', 'invalid_split', 'split: not outside the entry');
select throws_ok(format($$ select public.split_manual_entry(%L, null) $$, pg_temp.id('a')),
  '22023', 'invalid_split', 'split: needs a time');
select throws_ok(format($$ select public.split_manual_entry(%L, '2026-02-03 09:30:00-08') $$, pg_temp.id('r')),
  '55000', 'not_adjustable', 'split: not a rejected entry');

-- An odd second, to show nothing is rounded.
insert into pg_temp.ids values ('b', public.split_manual_entry(pg_temp.id('a'), '2026-02-02 10:47:13-08'));
select is(pg_temp.span('a'), '10:00:00-10:47:13 approved', 'split: the entry keeps the first part');
select is(pg_temp.span('b'), '10:47:13-12:00:00 approved', 'split: a new entry takes the rest, still approved');
select is(
  (select sum(extract(epoch from end_at - start_at)) from public.manual_entries
   where id in (pg_temp.id('a'), pg_temp.id('b'))),
  7200::numeric, 'split: the parts'' seconds sum to the entry''s exactly');
select is(
  (select row(b.project_id, b.task_id, b.note, b.reason, b.decided_by, b.decided_at, b.decision_note)::text
   from pg_temp.entry('b') b),
  (select row(a.project_id, a.task_id, a.note, a.reason, a.decided_by, a.decided_at, a.decision_note)::text
   from pg_temp.entry('a') a),
  'split: the new part has the same project, task, note, reason and decision');
select is(pg_temp.audited('manual_entry.split', :erin), 1, 'audit: the split is logged');
select is(pg_temp.audit_meta('manual_entry.split', :erin) -> 'seconds', '[2833, 4367]'::jsonb,
  'audit: with each part''s seconds');
select is(pg_temp.audit_meta('manual_entry.split', :erin) ->> 'new_entry_id', pg_temp.id('b')::text,
  'audit: and the new entry');

-- Merge ---------------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok(format($$ select public.merge_manual_entries(%L, %L) $$, pg_temp.id('a'), pg_temp.id('b')),
  '42501', 'not_your_entry', 'merge: the manager can''t merge the employee''s entries');

select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.merge_manual_entries(%L, %L) $$, pg_temp.id('a'), pg_temp.id('a')),
  '22023', 'invalid_merge', 'merge: two different entries');
select throws_ok(format($$ select public.merge_manual_entries(%L, %L) $$, pg_temp.id('b'), pg_temp.id('c')),
  '22023', 'not_adjacent', 'merge: entries that don''t touch');
select throws_ok(format($$ select public.merge_manual_entries(%L, %L) $$, pg_temp.id('c'), pg_temp.id('d')),
  '22023', 'not_same_assignment', 'merge: not across projects');
select throws_ok(format($$ select public.merge_manual_entries(%L, %L) $$, pg_temp.id('b'), pg_temp.id('r')),
  '55000', 'not_adjustable', 'merge: not a rejected entry');

-- Merged back, given in either order.
select is(public.merge_manual_entries(pg_temp.id('b'), pg_temp.id('a')), pg_temp.id('a'),
  'merge: the earlier entry is kept');
select is(pg_temp.span('a'), '10:00:00-12:00:00 approved', 'merge: back to the whole, still approved');
select is((select count(*)::int from public.manual_entries where id = pg_temp.id('b')), 0,
  'merge: the later entry is gone');
select is((select reason || '|' || note || '|' || decision_note from pg_temp.entry('a')),
  'Client workshop|Workshop notes|Fine', 'merge: same reason and note stay as they were');
select is(pg_temp.audited('manual_entry.merged', :erin), 1, 'audit: the merge is logged');
select is(jsonb_array_length(pg_temp.audit_meta('manual_entry.merged', :erin) -> 'before'), 2,
  'audit: with both entries as they were');

-- A merge with a pending entry is pending; different reasons and notes are joined.
select pg_temp.act_as(:erin);
select lives_ok(format($$ select public.edit_manual_entry(%L, '2026-02-02 14:00:00-08', '2026-02-02 14:30:00-08',
    null, 'Middle') $$, pg_temp.id('d')), 'edit: (setup) the Unassigned entry moves');
select pg_temp.act_as_postgres();
update public.manual_entries set project_id = :revamp where id = pg_temp.id('d');
select pg_temp.act_as(:erin);
select is(public.merge_manual_entries(pg_temp.id('c'), pg_temp.id('d')), pg_temp.id('c'), 'merge: pending entries');
select is((select reason || '|' || note from pg_temp.entry('c')), 'Offline|First half' || E'\n' || 'Middle',
  'merge: the notes are joined, the same reason kept');
select is(public.merge_manual_entries(pg_temp.id('e'), pg_temp.id('c')), pg_temp.id('c'), 'merge: and the next one');
select is((select reason from pg_temp.entry('c')), 'Offline' || E'\n' || 'Train back', 'merge: different reasons are joined');
select is(pg_temp.span('c'), '13:00:00-15:00:00 pending', 'merge: pending stays pending');

-- Approved and pending merge into pending: the pending time still needs approving.
insert into pg_temp.ids values ('a2', public.split_manual_entry(pg_temp.id('a'), '2026-02-02 11:00:00-08'));
select lives_ok(format($$ select public.edit_manual_entry(%L, '2026-02-02 11:00:00-08', '2026-02-02 11:30:00-08',
    null, 'Workshop notes') $$, pg_temp.id('a2')), 'edit: an approved part gets new times');
select is(pg_temp.span('a2'), '11:00:00-11:30:00 pending', 'edit: new times go back to pending');
select is((select decided_by::text || decided_at::text || decision_note from pg_temp.entry('a2')), null,
  'edit: and the decision is cleared');
select public.merge_manual_entries(pg_temp.id('a'), pg_temp.id('a2'));
select is(pg_temp.span('a'), '10:00:00-11:30:00 pending', 'merge: approved and pending make pending');

-- Edit ----------------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok(format($$ select public.edit_manual_entry(%L, '2026-02-02 10:00:00-08', '2026-02-02 11:00:00-08',
    null, null) $$, pg_temp.id('a')),
  '42501', 'not_your_entry', 'edit: the manager uses adjust_time instead');
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.edit_manual_entry(%L, '2026-02-02 10:00:00-08', '2026-02-02 13:30:00-08',
    null, null) $$, pg_temp.id('a')),
  '23P01', 'overlaps_manual_entry', 'edit: not over another entry');
select throws_ok(format($$ select public.edit_manual_entry(%L, now() - interval '1 hour', now() + interval '1 hour',
    null, null) $$, pg_temp.id('a')),
  '22023', 'in_the_future', 'edit: not into the future');
select throws_ok(format($$ select public.edit_manual_entry(%L, '2026-02-02 11:00:00-08', '2026-02-02 10:00:00-08',
    null, null) $$, pg_temp.id('a')),
  '22023', 'invalid_range', 'edit: the end is after the start');
select throws_ok(format($$ select public.edit_manual_entry(%L, '2026-02-02 10:00:00-08', '2026-02-02 11:30:00-08',
    null, repeat('x', 2001)) $$, pg_temp.id('a')),
  '22023', 'invalid_note', 'edit: a note is at most 2,000 characters');
select lives_ok(format($$ select public.edit_manual_entry(%L, '2026-02-02 09:30:00-08', '2026-02-02 11:30:00-08',
    null, '  Workshop and prep  ') $$, pg_temp.id('a')), 'edit: the employee changes the times and the note');
select is((select pg_temp.span('a') || '|' || note from pg_temp.entry('a')),
  '09:30:00-11:30:00 pending|Workshop and prep', 'edit: stored, note trimmed');
select is((pg_temp.audit_meta('manual_entry.edited', :erin) -> 'after' ->> 'start_at')::timestamptz,
  '2026-02-02 09:30:00-08'::timestamptz, 'audit: the edit is logged with the times after');

-- Someone who needs no approval keeps it: Ada (the owner at the top) edits her own entry.
select pg_temp.act_as(:ada);
insert into pg_temp.ids values ('ada', public.request_manual_entry('2026-02-02 10:00:00-05', '2026-02-02 11:00:00-05',
  null, 'Board meeting'));
select public.edit_manual_entry(pg_temp.id('ada'), '2026-02-02 10:00:00-05', '2026-02-02 12:00:00-05', null, null);
select is((select status || '/' || (decided_at is not null)::text from pg_temp.entry('ada')), 'approved/true',
  'edit: an auto-approved person''s entry stays approved');

-- Duplicate (a new request on another day) ------------------------------------------------------

select pg_temp.act_as(:erin);
-- To the next week's Tuesday.
insert into pg_temp.ids values ('copy', public.request_manual_entry('2026-02-10 13:00:00-08', '2026-02-10 15:00:00-08',
  :revamp, 'Offline', null, 'First half'));
select is(pg_temp.span('copy'), '13:00:00-15:00:00 pending', 'duplicate: a pending copy on the other day');
select is((pg_temp.audit_meta('manual_entry.requested', :erin) ->> 'entry_id'), pg_temp.id('copy')::text,
  'audit: the copy is logged as a request');

-- Locked weeks ----------------------------------------------------------------------------------

-- Submitted: the week is with the manager.
select pg_temp.act_as(:erin);
create temp table wk as select public.ensure_timesheet(:erin, '2026-02-02') as id;
grant select on wk to authenticated;
select public.submit_timesheet((select id from wk));
select throws_ok(format($$ select public.split_manual_entry(%L, '2026-02-02 10:00:00-08') $$, pg_temp.id('a')),
  '55000', 'timesheet_submitted', 'locked: no split while the week is submitted');
select throws_ok(format($$ select public.merge_manual_entries(%L, %L) $$, pg_temp.id('a'), pg_temp.id('c')),
  '55000', 'timesheet_submitted', 'locked: no merge');
select throws_ok(format($$ select public.edit_manual_entry(%L, '2026-02-02 09:30:00-08', '2026-02-02 11:00:00-08',
    null, null) $$, pg_temp.id('a')),
  '55000', 'timesheet_submitted', 'locked: no edit');

-- Returned: open again.
select pg_temp.act_as(:max);
select public.return_timesheet((select id from wk), 'Split the workshop');
select pg_temp.act_as(:erin);
select lives_ok(format($$ select public.split_manual_entry(%L, '2026-02-02 10:30:00-08') $$, pg_temp.id('a')),
  'returned: the employee splits again');

-- Approved: locked (TS-18).
select pg_temp.act_as_postgres();
update public.timesheets set status = 'approved', approved_at = now() where id = (select id from wk);
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.split_manual_entry(%L, '2026-02-02 10:00:00-08') $$, pg_temp.id('c')),
  '55000', 'timesheet_locked', 'locked: no split once approved');
select throws_ok(format($$ select public.merge_manual_entries(%L, %L) $$, pg_temp.id('a'), pg_temp.id('c')),
  '55000', 'timesheet_locked', 'locked: no merge');
select throws_ok(format($$ select public.edit_manual_entry(%L, '2026-02-02 13:00:00-08', '2026-02-02 14:00:00-08',
    null, null) $$, pg_temp.id('c')),
  '55000', 'timesheet_locked', 'locked: no edit');
select throws_ok($$ select public.request_manual_entry('2026-02-05 13:00:00-08', '2026-02-05 14:00:00-08',
    null, 'Offline') $$,
  '55000', 'day_locked', 'locked: no duplicate into it');
-- An entry of an open week can't move into the approved one.
select throws_ok(format($$ select public.edit_manual_entry(%L, '2026-02-06 13:00:00-08', '2026-02-06 15:00:00-08',
    null, null) $$, pg_temp.id('copy')),
  '55000', 'timesheet_locked', 'locked: an entry can''t move into an approved week');
select lives_ok(format($$ select public.split_manual_entry(%L, '2026-02-10 14:00:00-08') $$, pg_temp.id('copy')),
  'open: the next week''s entry still splits');

-- Nobody writes the table directly.
select throws_ok(format($$ update public.manual_entries set end_at = end_at + interval '1 hour' where id = %L $$,
    pg_temp.id('copy')),
  '42501', null, 'manual_entries: no direct writes');

select is(pg_temp.audited('manual_entry.split', :erin), 4, 'audit: every split');
select is(pg_temp.audited('manual_entry.merged', :erin), 4, 'audit: every merge');

select * from finish();
rollback;
