-- #264 (TS-34): favourite rows on the week grid, and copying last week's manual entries.
begin;
create extension if not exists pgtap with schema extensions;

select plan(46);

\set org '''00000000-0000-4000-8000-000000000001'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''
\set internal '''00000000-0000-4000-8000-0000000000f2'''

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

create function pg_temp.copied_audit(p_from uuid, p_entry uuid, p_actor uuid) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log
  where action = 'manual_entry.requested' and metadata ->> 'copied_from' = p_from::text
    and metadata ->> 'entry_id' = p_entry::text and actor_id = p_actor
$$;

-- Names for ids, so the tests read in words.
create table pg_temp.ids (name text primary key, id uuid);
grant select, insert on pg_temp.ids to authenticated;
create function pg_temp.id(p_name text) returns uuid
language sql as $$ select id from pg_temp.ids where name = p_name $$;
-- An entry as "HH:MI-HH:MI status" in Erin's zone, on its local day, read as the owner.
create function pg_temp.span(p_id uuid) returns text
language sql security definer as $$
  select to_char(start_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') || '-'
    || to_char(end_at at time zone 'America/Los_Angeles', 'HH24:MI') || ' ' || status
  from public.manual_entries where id = p_id
$$;
-- The result item of a copy for the entry called `p_name`.
create table pg_temp.result (r jsonb);
grant select, insert, delete on pg_temp.result to authenticated;
create function pg_temp.item(p_name text) returns jsonb
language sql as $$
  select o from pg_temp.result, jsonb_array_elements(r) o
  where (o ->> 'entry_id')::uuid = pg_temp.id(p_name)
$$;

-- Fixtures: tasks of Website revamp (one to be archived), and a project Erin isn't on.
insert into public.project_tasks (id, org_id, project_id, name, billable) values
  ('00000000-0000-4000-8000-00000000a264', :org, :revamp, 'Design', true),
  ('00000000-0000-4000-8000-00000000b264', :org, :revamp, 'Old work', true);
insert into public.projects (id, org_id, name)
values ('00000000-0000-4000-8000-00000000c264', :org, 'Not Erin''s');

-- Favourite rows --------------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is(public.set_timesheet_favourite(:revamp, null, true), true, 'pin: a project Erin logs to');
select is(public.set_timesheet_favourite(:revamp, null, true), true, 'pin: again is a no-op');
select is(public.set_timesheet_favourite(:revamp, '00000000-0000-4000-8000-00000000a264', true), true,
  'pin: a task of it, a row of its own');
select is((select count(*)::int from public.timesheet_favourites), 2, 'RLS: Erin reads her two pins');
select throws_ok($$ select public.set_timesheet_favourite('00000000-0000-4000-8000-00000000c264', null, true) $$,
  '22023', 'project_not_allowed', 'pin: not a project she can log to');
select throws_ok(format($$ select public.set_timesheet_favourite(%L, '00000000-0000-4000-8000-00000000a264', true) $$, :internal),
  '22023', 'task_not_allowed', 'pin: not a task of that project');
select throws_ok($$ select public.set_timesheet_favourite(null, null, true) $$,
  '22023', 'invalid_favourite', 'pin: a project is needed');
select throws_ok(format($$ insert into public.timesheet_favourites (user_id, org_id, project_id) values (%L, %L, %L) $$,
    :erin, :org, :internal),
  '42501', null, 'writes only through the function');

select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.timesheet_favourites), 0, 'RLS: Lucas reads none of Erin''s');
select pg_temp.act_as(:max);
select is((select count(*)::int from public.timesheet_favourites), 0, 'RLS: nor does her manager');

select pg_temp.act_as(:erin);
select is(public.set_timesheet_favourite(:revamp, null, false), false, 'unpin');
select is((select string_agg(coalesce(task_id::text, '-'), ',') from public.timesheet_favourites),
  '00000000-0000-4000-8000-00000000a264', 'unpin: only that row goes');

-- At most 50.
select pg_temp.act_as_postgres();
insert into public.project_tasks (org_id, project_id, name, billable)
select :org, :revamp, 'Task ' || n, true from generate_series(1, 50) n;
insert into public.timesheet_favourites (user_id, org_id, project_id, task_id)
select :erin, :org, :revamp, t.id from public.project_tasks t
where t.project_id = :revamp and t.name like 'Task %' and t.name <> 'Task 50';
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.set_timesheet_favourite(%L, null, true) $$, :revamp),
  '22023', 'too_many_favourites', 'pin: at most 50');
select is(public.set_timesheet_favourite(:revamp, '00000000-0000-4000-8000-00000000a264', true), true,
  'pin: one already pinned is fine at the limit');
select pg_temp.act_as_postgres();
delete from public.timesheet_favourites where task_id in (
  select id from public.project_tasks where name like 'Task %');
-- A pin goes with its task.
delete from public.project_tasks where id = '00000000-0000-4000-8000-00000000a264';
select is((select count(*)::int from public.timesheet_favourites where user_id = :erin), 0,
  'a pin goes with its task');

-- Copying last week ---------------------------------------------------------------------------
-- Erin (America/Los_Angeles) copies the week of 2 March 2026 (PST, -08) into the week of
-- 9 March (PDT from the 8th, -07): the same local times, whatever the offset.

insert into public.project_tasks (id, org_id, project_id, name, billable) values
  ('00000000-0000-4000-8000-00000000d264', :org, :revamp, 'Build', true);

select pg_temp.act_as(:erin);
insert into pg_temp.ids values
  ('a', public.request_manual_entry('2026-03-02 10:00:00-08', '2026-03-02 12:00:00-08', :revamp,
    'Client workshop', '00000000-0000-4000-8000-00000000d264', 'Workshop notes')),
  ('b', public.request_manual_entry('2026-03-03 09:00:00-08', '2026-03-03 10:00:00-08', null,
    'Offline', null, null)),
  ('overlap', public.request_manual_entry('2026-03-04 09:00:00-08', '2026-03-04 10:00:00-08', :revamp,
    'Will overlap', null, null)),
  ('left', public.request_manual_entry('2026-03-05 09:00:00-08', '2026-03-05 10:00:00-08', :internal,
    'Project left', null, null)),
  ('archived', public.request_manual_entry('2026-03-05 11:00:00-08', '2026-03-05 12:00:00-08', :revamp,
    'Task archived', '00000000-0000-4000-8000-00000000b264', null)),
  ('rejected', public.request_manual_entry('2026-03-06 09:00:00-08', '2026-03-06 10:00:00-08', :revamp,
    'Will be rejected', null, null)),
  ('night', public.request_manual_entry('2026-03-08 23:00:00-07', '2026-03-09 00:30:00-07', :revamp,
    'Night deploy', null, null)),
  -- Already in the week copied into: overlaps the copy of 'overlap'.
  ('there', public.request_manual_entry('2026-03-11 09:30:00-07', '2026-03-11 10:30:00-07', null,
    'Already there', null, null)),
  -- Not last week's: the week before.
  ('older', public.request_manual_entry('2026-02-27 09:00:00-08', '2026-02-27 10:00:00-08', null,
    'Older', null, null));

select pg_temp.act_as(:max);
select public.decide_manual_entry(pg_temp.id('a'), true, 'Fine');
select public.decide_manual_entry(pg_temp.id('rejected'), false);
select pg_temp.act_as(:lucas);
insert into pg_temp.ids values
  ('lucas', public.request_manual_entry('2026-03-03 09:00:00-06', '2026-03-03 10:00:00-06', null,
    'Lucas''s', null, null));

-- Since then: Erin left Internal, a task was archived, and the week after is approved.
select pg_temp.act_as_postgres();
delete from public.project_members where project_id = :internal and user_id = :erin;
update public.project_tasks set archived = true where id = '00000000-0000-4000-8000-00000000b264';
insert into public.timesheets (org_id, user_id, period_start, status, approver_id, approved_at)
values (:org, :erin, '2026-03-16', 'approved', :max, now());

select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.copy_week_manual_entries('2026-03-10', array[%L]::uuid[]) $$, pg_temp.id('a')),
  '22023', 'invalid_copy', 'copy: into the start of a week only');
select throws_ok($$ select public.copy_week_manual_entries('2026-03-09', array[]::uuid[]) $$,
  '22023', 'invalid_copy', 'copy: at least one entry');

insert into pg_temp.result select public.copy_week_manual_entries('2026-03-09', array[
  pg_temp.id('a'), pg_temp.id('b'), pg_temp.id('overlap'), pg_temp.id('left'), pg_temp.id('archived'),
  pg_temp.id('rejected'), pg_temp.id('night'), pg_temp.id('older'), pg_temp.id('lucas')]);

select is((select jsonb_array_length(r) from pg_temp.result), 9, 'copy: one item per entry');
select is(pg_temp.span((pg_temp.item('a') ->> 'id')::uuid), '2026-03-09 10:00-12:00 pending',
  'copy: same weekday and local times across the clock change, and pending (TS-08)');
select is(
  (select project_id::text || ' ' || task_id::text || ' ' || reason || ' ' || note
   from public.manual_entries where id = (pg_temp.item('a') ->> 'id')::uuid),
  '00000000-0000-4000-8000-0000000000f1 00000000-0000-4000-8000-00000000d264 Client workshop Workshop notes',
  'copy: same project, task, reason and note');
select is(pg_temp.span((pg_temp.item('b') ->> 'id')::uuid), '2026-03-10 09:00-10:00 pending',
  'copy: an Unassigned entry too');
select is(pg_temp.item('overlap') ->> 'skipped', 'overlaps_manual_entry', 'skipped: overlaps an entry');
select is(pg_temp.item('left') ->> 'skipped', 'project_not_allowed', 'skipped: a project she left');
select is(pg_temp.item('archived') ->> 'skipped', 'task_not_allowed', 'skipped: an archived task');
select is(pg_temp.item('night') ->> 'skipped', 'day_locked', 'skipped: runs into an approved week');
select is(pg_temp.item('rejected') ->> 'skipped', 'entry_not_found', 'skipped: rejected time isn''t copied');
select is(pg_temp.item('older') ->> 'skipped', 'entry_not_found', 'skipped: not last week''s');
select is(pg_temp.item('lucas') ->> 'skipped', 'entry_not_found', 'skipped: someone else''s');
select ok((pg_temp.item('overlap') ->> 'start_at')::timestamptz = '2026-03-11 09:00:00-07',
  'skipped items say where they would have gone');
select is(
  (select count(*)::int from public.manual_entries
   where user_id = :erin and start_at >= '2026-03-09 00:00:00-07' and start_at < '2026-03-16 00:00:00-07'),
  3, 'copy: only the copies were added (with the entry already there)');
select is(pg_temp.audited('manual_entry.requested', :erin), 11,
  'audit: each copy is a request (9 asked + 2 copied), skipped ones leave none');
select is(pg_temp.copied_audit(pg_temp.id('a'), (pg_temp.item('a') ->> 'id')::uuid, :erin),
  1, 'audit: the copy names its source');
select is(
  (select status from public.timesheets where user_id = :erin and period_start = '2026-03-09'),
  'draft', 'copy: the week copied into exists, a draft');

-- Copying again: the copies are there now, so everything overlaps; nothing is added.
delete from pg_temp.result;
insert into pg_temp.result select public.copy_week_manual_entries('2026-03-09', array[pg_temp.id('a')]);
select is(pg_temp.item('a') ->> 'skipped', 'overlaps_manual_entry', 'copying twice: skipped, overlaps the copy');

-- The week must be open for her changes (TS-30, TS-18).
select pg_temp.act_as_postgres();
update public.timesheets set status = 'submitted', submitted_at = now()
where user_id = :erin and period_start = '2026-03-09';
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.copy_week_manual_entries('2026-03-09', array[%L]::uuid[]) $$, pg_temp.id('b')),
  '55000', 'timesheet_submitted', 'copy: not into a submitted week');
select pg_temp.act_as_postgres();
update public.timesheets set status = 'approved', approver_id = :max, approved_at = now()
where user_id = :erin and period_start = '2026-03-09';
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.copy_week_manual_entries('2026-03-09', array[%L]::uuid[]) $$, pg_temp.id('b')),
  '55000', 'timesheet_locked', 'copy: not into an approved week');
select pg_temp.act_as_postgres();
update public.timesheets set status = 'returned', approver_id = null, approved_at = null
where user_id = :erin and period_start = '2026-03-09';
select pg_temp.act_as(:erin);
delete from pg_temp.result;
select lives_ok(format($$ insert into pg_temp.result select public.copy_week_manual_entries('2026-03-09', array[%L]::uuid[]) $$,
    pg_temp.id('b')),
  'copy: into a returned week');
select is(pg_temp.item('b') ->> 'skipped', 'overlaps_manual_entry', 'returned: the rules still apply');

-- Not in the future: last week's entry that runs up to now runs past now this week.
select pg_temp.act_as(:erin);
insert into pg_temp.ids values
  ('recent', public.request_manual_entry(now() - interval '7 days' - interval '1 minute',
    now() - interval '7 days' + interval '3 hours', null, 'Recent', null, null));
delete from pg_temp.result;
select pg_temp.act_as_postgres();
select internal.week_start(:org, (now() at time zone 'America/Los_Angeles')::date) as this_week \gset
select pg_temp.act_as(:erin);
insert into pg_temp.result select public.copy_week_manual_entries(:'this_week', array[pg_temp.id('recent')]);
select is(pg_temp.item('recent') ->> 'skipped', 'in_the_future', 'skipped: it would end in the future');

-- Someone who needs no approval (TS-16): Ada, with no manager. Copies are approved at once.
select pg_temp.act_as(:ada);
insert into pg_temp.ids values
  ('ada', public.request_manual_entry('2026-03-03 09:00:00-05', '2026-03-03 10:00:00-05', null,
    'Board prep', null, null));
delete from pg_temp.result;
insert into pg_temp.result select public.copy_week_manual_entries('2026-03-09', array[pg_temp.id('ada')]);
select is(
  (select status from public.manual_entries where id = (pg_temp.item('ada') ->> 'id')::uuid),
  'approved', 'no approval needed: the copy is approved (TS-16)');
select is(pg_temp.audited('manual_entry.auto_approved', :ada), 2, 'audit: auto-approved, the original and the copy');

-- Other people can't copy into her week, and the functions need a signed-in user.
select pg_temp.act_as(:max);
delete from pg_temp.result;
insert into pg_temp.result select public.copy_week_manual_entries('2026-03-09', array[pg_temp.id('b')]);
select is(pg_temp.item('b') ->> 'skipped', 'entry_not_found', 'her manager copies only his own entries');
select pg_temp.act_as_postgres();
select set_config('role', 'anon', true);
select throws_ok($$ select public.copy_week_manual_entries('2026-03-09', array[gen_random_uuid()]) $$,
  '42501', null, 'anon: no copy');
select throws_ok($$ select public.set_timesheet_favourite(gen_random_uuid(), null, true) $$,
  '42501', null, 'anon: no pins');
select pg_temp.act_as_postgres();

-- Deleting the person deletes their pins (the rest of deletion is in data_requests).
insert into public.timesheet_favourites (user_id, org_id, project_id) values (:lucas, :org, :revamp);
select is(
  (select confdeltype from pg_constraint where conname = 'timesheet_favourites_user_id_fkey'),
  'c', 'pins go with the person');
select is(
  (select confdeltype from pg_constraint where conname = 'timesheet_favourites_project_id_fkey'),
  'c', 'and with the project');

select * from finish();
rollback;
