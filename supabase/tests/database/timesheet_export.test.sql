begin;
create extension if not exists pgtap with schema extensions;

select plan(36);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set mia '''00000000-0000-4000-8000-0000000000d1'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''
\set internal '''00000000-0000-4000-8000-0000000000f2'''
\set northwind '''00000000-0000-4000-8000-0000000000e1'''
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

-- Export audit rows so far, read as the owner of the database.
create function pg_temp.exports() returns int
language sql security definer as $$
  select count(*)::int from public.audit_log where action = 'timesheet.exported'
$$;

-- The rows of an export, as a json array; the second week and every filter default to none.
create function pg_temp.rows(
  p_from date, p_to date, p_view text default 'segments',
  p_user_ids uuid[] default null, p_manager_id uuid default null,
  p_client_ids uuid[] default null, p_project_ids uuid[] default null,
  p_statuses text[] default null
) returns jsonb
language sql as $$
  select public.timesheet_export_rows(p_from, p_to, p_view, p_user_ids, p_manager_id,
    p_client_ids, p_project_ids, p_statuses) -> 'rows'
$$;

-- Mia manages nobody involved here.
insert into auth.users (id, email) values (:mia, 'mia@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id)
values (:mia, :org, 'Mia Manager', 'mia@acme.test', 'manager', :ada);

-- Erin is in America/Los_Angeles (-07 in March 2026), Lucas in America/Chicago (-05).
-- Erin, Monday: verified 09:00-11:00 (Website revamp), idle 11:00-11:20, unverified
-- 11:20-11:45 (excluded), break 11:45-12:00, verified 12:00-13:00 with no project, manual
-- 13:00-14:00 (Internal). Lucas, Monday: verified 09:00-10:00 (Website revamp).
insert into public.time_segments
  (org_id, user_id, day, start_at, end_at, type, project_id, counted, flagged, excluded)
values
  (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 11:00:00-07', 'verified', :revamp, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07', 'idle', :revamp, true, true, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:20:00-07', '2026-03-16 11:45:00-07', 'unverified', :revamp, true, true, true),
  (:org, :erin, '2026-03-16', '2026-03-16 11:45:00-07', '2026-03-16 12:00:00-07', 'break', :revamp, false, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 12:00:00-07', '2026-03-16 13:00:00-07', 'verified', null, true, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 13:00:00-07', '2026-03-16 14:00:00-07', 'manual', :internal, true, false, false),
  (:org, :lucas, '2026-03-16', '2026-03-16 09:00:00-05', '2026-03-16 10:00:00-05', 'verified', :revamp, true, false, false);

-- Erin's week is approved by Max; Lucas has not opened his (no timesheet row).
insert into public.timesheets (org_id, user_id, period_start, status, approver_id, approved_at)
values (:org, :erin, '2026-03-16', 'approved', :max, now());

-- Who sees what ----------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22')), 6,
  'an employee exports her own segments, and nobody else''s');
select is(
  (select sum((r ->> 'seconds')::bigint)::text from jsonb_array_elements(pg_temp.rows('2026-03-16', '2026-03-22')) r
   where (r ->> 'counted')::boolean and not (r ->> 'excluded')::boolean),
  (select worked_s::text from public.timesheet_totals('2026-03-16', '2026-03-22') where user_id = :erin),
  'the rows add up to timesheet_totals worked seconds');
select throws_ok(format($$ select pg_temp.rows('2026-03-16', '2026-03-22', 'segments', array[%L]::uuid[]) $$, :lucas),
  '42501', 'forbidden', 'an employee cannot name a peer');

select pg_temp.act_as(:lucas);
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22')), 1, 'a peer sees only their own segments');
select throws_ok(format($$ select pg_temp.rows('2026-03-16', '2026-03-22', 'daily', array[%L]::uuid[]) $$, :erin),
  '42501', 'forbidden', 'a peer cannot export Erin''s time');
select throws_ok(format($$ select pg_temp.rows('2026-03-16', '2026-03-22', 'daily', array[%L, %L]::uuid[]) $$, :lucas, :erin),
  '42501', 'forbidden', 'one name the peer may not view refuses the whole export');

select pg_temp.act_as(:mia);
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22')), 0, 'a manager of nobody involved sees none of it');
select throws_ok(format($$ select pg_temp.rows('2026-03-16', '2026-03-22', 'daily', array[%L]::uuid[]) $$, :erin),
  '42501', 'forbidden', 'nor can they name Erin');

select pg_temp.act_as(:max);
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22')), 7, 'the manager exports their reports');
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22', 'daily', array[:erin]::uuid[])), 6,
  'filter: one employee');
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22', 'daily', null, :max)), 7,
  'filter: the manager''s direct reports (the team filter until ORG-08)');
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22', 'daily', null, :ada)), 0,
  'filter: another manager''s reports are none of these');
select is(jsonb_array_length(pg_temp.rows('2026-03-17', '2026-03-22')), 0, 'filter: date range, by the employee''s local day');
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-16')), 7, 'filter: a single day');
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22', 'project', null, null, array[:northwind]::uuid[])), 5,
  'filter: client (leaves out Internal and Unassigned time)');
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22', 'project', null, null, null, array[:internal]::uuid[])), 1,
  'filter: project');
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22', 'daily', null, null, null, null, array['approved'])), 6,
  'filter: approval status (Erin''s approved week)');
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22', 'daily', null, null, null, null, array['draft'])), 1,
  'filter: a week nobody opened counts as draft');
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22', 'daily', null, null, null, null, array['submitted', 'returned'])), 0,
  'filter: statuses combine as "any of"');
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22', 'daily', '{}', null, '{}', '{}', '{}')), 7,
  'filter: empty lists mean no filter');

select pg_temp.act_as(:ada);
select is(jsonb_array_length(pg_temp.rows('2026-03-16', '2026-03-22')), 7, 'the owner exports everyone');

-- What a row holds ------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select is(
  (select r::text from jsonb_array_elements(pg_temp.rows('2026-03-16', '2026-03-22', 'segments', array[:erin]::uuid[])) r
   where r ->> 'type' = 'verified' and r ->> 'project_id' is not null),
  jsonb_build_object(
    'user_id', :erin::uuid, 'employee', 'Erin Employee', 'email', 'erin@acme.test',
    'timezone', 'America/Los_Angeles', 'day', '2026-03-16',
    'start_local', '2026-03-16 09:00:00', 'end_local', '2026-03-16 11:00:00', 'type', 'verified',
    'project_id', :revamp::uuid, 'project', 'Website revamp', 'client_id', :northwind::uuid, 'client', 'Northwind',
    'billable', true, 'counted', true, 'flagged', false, 'excluded', false, 'seconds', 7200,
    'status', 'approved', 'approver', 'Max Manager')::text,
  'a row: person, local day and times, project, client, billable, flags, raw seconds, status, approver');
select is(
  (select r - 'user_id' - 'employee' - 'email' - 'timezone' - 'day' - 'start_local' - 'end_local' - 'type'
          - 'counted' - 'flagged' - 'excluded' - 'seconds' - 'status' - 'approver'
   from jsonb_array_elements(pg_temp.rows('2026-03-16', '2026-03-22', 'segments', array[:erin]::uuid[])) r
   where r ->> 'project_id' is null),
  '{"project": null, "client": null, "client_id": null, "project_id": null, "billable": false}'::jsonb,
  'unassigned time has no project or client and is not billable');
select is(
  (select (r ->> 'billable')::boolean from jsonb_array_elements(pg_temp.rows('2026-03-16', '2026-03-22', 'segments', array[:erin]::uuid[])) r
   where r ->> 'project' = 'Internal'),
  false, 'a non-billable project is not billable');
select is(
  (select r ->> 'start_local' from jsonb_array_elements(pg_temp.rows('2026-03-16', '2026-03-22', 'segments', array[:lucas]::uuid[])) r),
  '2026-03-16 09:00:00', 'times are in the employee''s own zone');
select is(
  (select (r ->> 'status') || '/' || coalesce(r ->> 'approver', '-')
   from jsonb_array_elements(pg_temp.rows('2026-03-16', '2026-03-22', 'segments', array[:lucas]::uuid[])) r),
  'draft/-', 'an unopened week is draft with no approver');
select is(
  (select jsonb_agg(r ->> 'type' order by r ->> 'start_local') from jsonb_array_elements(pg_temp.rows('2026-03-16', '2026-03-22', 'segments', array[:erin]::uuid[])) r)::text,
  '["verified", "idle", "unverified", "break", "verified", "manual"]', 'rows come in time order');

-- Invalid requests ---------------------------------------------------------------------------------

select throws_ok($$ select pg_temp.rows('2026-03-16', '2026-03-22', 'weekly') $$, '22023', 'invalid_view', 'an unknown view is refused');
select throws_ok($$ select pg_temp.rows('2026-03-22', '2026-03-16') $$, '22023', 'invalid_range', 'a range that ends before it starts is refused');
select throws_ok($$ select pg_temp.rows('2025-01-01', '2026-03-16') $$, '22023', 'invalid_range', 'more than a year is refused');
select throws_ok($$ select pg_temp.rows('2026-03-16', '2026-03-22', 'daily', null, null, null, null, array['pending']) $$,
  '22023', 'invalid_status', 'an unknown status is refused');

-- Audit (AUD-01) ------------------------------------------------------------------------------------

select pg_temp.act_as_postgres();
select is(pg_temp.exports(), 23,
  'audit: every export that returned rows or none is logged; refused ones are not');
select is(
  (select (metadata ->> 'view') || '/' || (metadata ->> 'from') || '/' || (metadata ->> 'to') || '/' || (metadata ->> 'row_count')
   from public.audit_log where action = 'timesheet.exported' and actor_id = :max and target_user_id = :erin
   order by id limit 1),
  'daily/2026-03-16/2026-03-22/6', 'audit: view, range and row count, about the one employee named');
select is(
  (select metadata -> 'statuses' from public.audit_log where action = 'timesheet.exported' and metadata -> 'statuses' = '["approved"]'::jsonb limit 1),
  '["approved"]'::jsonb, 'audit: the filters used');
select is(
  (select count(*)::int from public.audit_log where action = 'timesheet.exported' and target_user_id is null and actor_id = :ada),
  1, 'audit: a wider export has no single target');

-- Permissions ------------------------------------------------------------------------------------------

select set_config('role', 'anon', true);
select throws_ok($$ select public.timesheet_export_rows('2026-03-16', '2026-03-22', 'daily') $$,
  '42501', null, 'anon cannot call it');

select * from finish();
rollback;
