begin;
create extension if not exists pgtap with schema extensions;

select plan(46);

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

-- Audit rows of one action for one entry, read as the database owner.
create function pg_temp.audited(act text, entry uuid) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log where action = act and metadata ->> 'entry_id' = entry::text
$$;

-- Mia manages nobody involved here: she can neither read nor decide Erin's entries.
insert into auth.users (id, email) values (:mia, 'mia@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id)
values (:mia, :org, 'Mia Manager', 'mia@acme.test', 'manager', :ada);

create temp table dev as
with d as (
  insert into public.devices (org_id, user_id, platform, os_version, agent_version, hardware_hash)
  values (:org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-manual') returning id
)
select id as erin_device from d;
grant select on dev to authenticated;

-- Erin is in America/Los_Angeles; March 16 2026 is daylight time (-07).
-- Requests ----------------------------------------------------------------------------

select pg_temp.act_as(:erin);
create temp table e1 as
select public.request_manual_entry('2026-03-16 14:00:00-07', '2026-03-16 15:00:00-07', :revamp, '  Client visit  ') as id;
grant select on e1 to authenticated;
select ok((select id from e1) is not null, 'request: an employee asks for a manual entry');
select is(
  (select (status, reason, project_id, decided_at is null)::text from public.manual_entries where id = (select id from e1)),
  '(pending,"Client visit",00000000-0000-4000-8000-0000000000f1,t)',
  'request: pending, reason trimmed, project kept');
select is(pg_temp.dirty(:erin), '', 'request: a pending entry marks no day, it is not counted');

select throws_ok($$ select public.request_manual_entry('2026-03-16 14:30:00-07', '2026-03-16 15:30:00-07', null, 'Overlap') $$,
  '23P01', 'overlaps_manual_entry', 'request: cannot overlap another pending entry');
select lives_ok($$ select public.request_manual_entry('2026-03-16 15:00:00-07', '2026-03-16 16:00:00-07', null, 'Next hour') $$,
  'request: entries that only touch are fine, and no project is Unassigned');

select pg_temp.act_as_postgres();
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
values (:org, :erin, (select erin_device from dev), '2026-03-16 09:00:00-07', '2026-03-16 12:00:00-07', gen_random_uuid());
select pg_temp.act_as(:erin);
select throws_ok($$ select public.request_manual_entry('2026-03-16 11:00:00-07', '2026-03-16 13:00:00-07', null, 'Overlap') $$,
  '23P01', 'overlaps_clocked_time', 'request: cannot overlap clocked time');
select lives_ok($$ select public.request_manual_entry('2026-03-16 12:00:00-07', '2026-03-16 13:00:00-07', null, 'Right after') $$,
  'request: starting exactly when a session ends is fine');

select pg_temp.act_as_postgres();
insert into public.clock_sessions (org_id, user_id, device_id, start_at, start_event_id)
values (:org, :erin, (select erin_device from dev), now() - interval '1 hour', gen_random_uuid());
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.request_manual_entry(%L, %L, null, 'Overlap') $$,
  now() - interval '30 minutes', now() - interval '10 minutes'),
  '23P01', 'overlaps_clocked_time', 'request: an open session runs to now');
select pg_temp.act_as_postgres();
delete from public.clock_sessions where user_id = :erin and end_at is null;
select pg_temp.act_as(:erin);

select throws_ok(format($$ select public.request_manual_entry(%L, %L, null, 'Later') $$,
  now() - interval '1 hour', now() + interval '1 hour'),
  '22023', 'in_the_future', 'request: cannot end in the future');
select throws_ok($$ select public.request_manual_entry('2026-03-17 10:00:00-07', '2026-03-17 10:00:00-07', null, 'Empty') $$,
  '22023', 'invalid_range', 'request: end must be after start');
select throws_ok($$ select public.request_manual_entry('2026-03-17 10:00:00-07', '2026-03-18 10:00:01-07', null, 'Long') $$,
  '22023', 'range_too_long', 'request: at most 24 hours');
select throws_ok($$ select public.request_manual_entry('2026-03-17 10:00:00-07', '2026-03-17 11:00:00-07', null, '   ') $$,
  '22023', 'invalid_reason', 'request: a reason is required');
select throws_ok(format($$ select public.request_manual_entry('2026-03-17 10:00:00-07', '2026-03-17 11:00:00-07', null, %L) $$,
  repeat('x', 501)),
  '22023', 'invalid_reason', 'request: and at most 500 characters');

select pg_temp.act_as(:lucas);
select throws_ok($$ select public.request_manual_entry('2026-03-17 10:00:00-07', '2026-03-17 11:00:00-07',
  '00000000-0000-4000-8000-0000000000f2', 'Not mine') $$,
  '22023', 'project_not_allowed', 'request: a project the person is not assigned to is refused');

-- Reading ----------------------------------------------------------------------------

select is((select count(*)::int from public.manual_entries), 0, 'RLS: a peer sees none of Erin''s entries');
select pg_temp.act_as(:mia);
select is((select count(*)::int from public.manual_entries), 0, 'RLS: another manager sees none either');
select pg_temp.act_as(:erin);
select is((select count(*)::int from public.manual_entries), 3, 'RLS: Erin sees her own');
select throws_ok($$ insert into public.manual_entries (org_id, user_id, start_at, end_at, reason, status, decided_at)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
    '2026-03-18 10:00:00-07', '2026-03-18 11:00:00-07', 'Sneaky', 'approved', now()) $$,
  '42501', null, 'no direct client writes: insert');
select throws_ok($$ update public.manual_entries set status = 'approved', decided_at = now() $$,
  '42501', null, 'no direct client writes: update');

-- Pending entries are not inputs --------------------------------------------------------

select pg_temp.act_as_postgres();
select is(public.segment_inputs(:erin, '2026-03-16') -> 'input' -> 'manualEntries', '[]'::jsonb,
  'segment_inputs: pending entries are not counted');

-- Deciding ----------------------------------------------------------------------------

select pg_temp.act_as(:lucas);
select throws_ok(format($$ select public.decide_manual_entry(%L, true) $$, (select id from e1)),
  '42501', 'entry_not_found', 'decide: a peer cannot');
select pg_temp.act_as(:mia);
select throws_ok(format($$ select public.decide_manual_entry(%L, true) $$, (select id from e1)),
  '42501', 'entry_not_found', 'decide: another manager cannot');
select pg_temp.act_as(:ada);
select is((select count(*)::int from public.manual_entries), 3, 'RLS: the owner can read (view only)');
select throws_ok(format($$ select public.decide_manual_entry(%L, true) $$, (select id from e1)),
  '42501', 'not_the_manager', 'decide: an owner who is not the direct manager cannot');
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.decide_manual_entry(%L, true) $$, (select id from e1)),
  '42501', 'not_the_manager', 'decide: nobody decides their own entry');

select pg_temp.act_as_postgres();
delete from public.dirty_days;
select pg_temp.act_as(:max);
select is((select count(*)::int from public.manual_entries), 3, 'RLS: the direct manager reads the entries');
select lives_ok(format($$ select public.decide_manual_entry(%L, true, '  ok  ') $$, (select id from e1)),
  'decide: the direct manager approves');
select is(
  (select (status, decided_by, decision_note, decided_at is not null)::text from public.manual_entries where id = (select id from e1)),
  '(approved,00000000-0000-4000-8000-0000000000b1,ok,t)', 'decide: decision recorded with the trimmed note');
select throws_ok(format($$ select public.decide_manual_entry(%L, false) $$, (select id from e1)),
  '55000', 'not_pending', 'decide: only pending entries');
select pg_temp.act_as_postgres();
select is(pg_temp.dirty(:erin), '2026-03-16', 'approve: marks the entry''s day dirty');
select is(public.segment_inputs(:erin, '2026-03-16') -> 'input' -> 'manualEntries',
  jsonb_build_array(jsonb_build_object('start', pg_temp.epoch('2026-03-16 14:00:00-07'),
    'end', pg_temp.epoch('2026-03-16 15:00:00-07'), 'projectId', '00000000-0000-4000-8000-0000000000f1')),
  'segment_inputs: only the approved entry, in DayInput shape');

-- Reject, and re-check on approve --------------------------------------------------------

select pg_temp.act_as(:erin);
create temp table e2 as
select public.request_manual_entry('2026-03-17 10:00:00-07', '2026-03-17 11:00:00-07', null, 'Whiteboard') as id;
grant select on e2 to authenticated;
select pg_temp.act_as_postgres();
delete from public.dirty_days;
select pg_temp.act_as(:max);
select lives_ok(format($$ select public.decide_manual_entry(%L, false, 'Not enough detail') $$, (select id from e2)),
  'decide: the manager rejects');
select pg_temp.act_as_postgres();
select is(pg_temp.dirty(:erin), '', 'reject: marks nothing');
select is(jsonb_array_length(public.segment_inputs(:erin, '2026-03-17') -> 'input' -> 'manualEntries'), 0,
  'segment_inputs: rejected entries are not counted');
select pg_temp.act_as(:erin);
select lives_ok($$ select public.request_manual_entry('2026-03-17 10:00:00-07', '2026-03-17 11:00:00-07', null, 'Again') $$,
  'request: a rejected entry does not block asking again');
create temp table e3 as
select id from public.manual_entries where reason = 'Again';
grant select on e3 to authenticated;

-- She clocks in over the pending entry before it is decided.
select pg_temp.act_as_postgres();
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
values (:org, :erin, (select erin_device from dev), '2026-03-17 10:30:00-07', '2026-03-17 12:00:00-07', gen_random_uuid());
select pg_temp.act_as(:max);
select throws_ok(format($$ select public.decide_manual_entry(%L, true) $$, (select id from e3)),
  '23P01', 'overlaps_clocked_time', 'decide: approving re-checks the overlap with clocked time');
select lives_ok(format($$ select public.decide_manual_entry(%L, false) $$, (select id from e3)),
  'decide: but it can still be rejected');

-- Cancel ----------------------------------------------------------------------------------

select pg_temp.act_as(:erin);
create temp table e4 as
select public.request_manual_entry('2026-03-18 10:00:00-07', '2026-03-18 11:00:00-07', null, 'Changed my mind') as id;
grant select on e4 to authenticated;
select pg_temp.act_as(:lucas);
select throws_ok(format($$ select public.cancel_manual_entry(%L) $$, (select id from e4)),
  '42501', 'entry_not_found', 'cancel: only the owner of the entry');
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.cancel_manual_entry(%L) $$, (select id from e1)),
  '55000', 'not_pending', 'cancel: not once decided');
select lives_ok(format($$ select public.cancel_manual_entry(%L) $$, (select id from e4)),
  'cancel: the employee withdraws a pending entry');

-- Locked days and approval-free people -----------------------------------------------------

select pg_temp.act_as_postgres();
create or replace function internal.day_locked(p_user_id uuid, p_day date)
returns boolean language sql as $$ select p_day = '2026-03-19' $$;
select pg_temp.act_as(:erin);
select throws_ok($$ select public.request_manual_entry('2026-03-19 10:00:00-07', '2026-03-19 11:00:00-07', null, 'Locked') $$,
  '55000', 'day_locked', 'request: not into a locked day');
select pg_temp.act_as_postgres();
create or replace function internal.day_locked(p_user_id uuid, p_day date)
returns boolean language sql as $$ select false $$;

select pg_temp.act_as(:ada);
create temp table e5 as
select public.request_manual_entry('2026-03-20 10:00:00-07', '2026-03-20 11:00:00-07', null, 'Owner time') as id;
grant select on e5 to authenticated;
select is((select status from public.manual_entries where id = (select id from e5)), 'approved',
  'request: the owner, with nobody above, is approved at once (TS-16)');

-- Audit -------------------------------------------------------------------------------------

select pg_temp.act_as_postgres();
select is(
  (select array_agg(action order by id) from public.audit_log
   where metadata ->> 'entry_id' = (select id from e1)::text),
  array['manual_entry.requested', 'manual_entry.approved'], 'audit: request and approval of the first entry');
select is(pg_temp.audited('manual_entry.rejected', (select id from e2)), 1, 'audit: rejection');
select is(pg_temp.audited('manual_entry.cancelled', (select id from e4)), 1, 'audit: cancellation');
select is(pg_temp.audited('manual_entry.auto_approved', (select id from e5)), 1, 'audit: auto-approval');

select * from finish();
rollback;
