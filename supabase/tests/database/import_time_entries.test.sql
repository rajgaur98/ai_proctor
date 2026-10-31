-- #282: import_apply's time_entries kind. Each item is a manual entry for the person under
-- request_manual_entry's rules (internal.create_manual_entry), audited like a request with
-- the importing admin as actor; re-importing the same rows changes nothing.
begin;
create extension if not exists pgtap with schema extensions;

select plan(31);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set org '''00000000-0000-4000-8000-000000000001'''
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

-- The DETAIL of the error a statement raises (null when it doesn't raise).
create function pg_temp.detail_of(sql text) returns text
language plpgsql as $$
declare
  v text;
begin
  execute sql;
  return null;
exception when others then
  get stacked diagnostics v = pg_exception_detail;
  return v;
end;
$$;

-- One time-entry payload: items as a JSON array.
create function pg_temp.payload(items text) returns jsonb
language sql as $$ select jsonb_build_object('kind', 'time_entries', 'items', items::jsonb) $$;

-- Fixtures: tasks of Website revamp (one archived), Erin's device and a clocked session,
-- and an approved week of Erin's. Erin is in America/Los_Angeles (-07 in March 2026).
insert into public.project_tasks (org_id, project_id, name, billable, archived)
values (:org, :revamp, 'Design', true, false), (:org, :revamp, 'Old work', true, true);
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000d9', :org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-import');
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
values (:org, :erin, '00000000-0000-4000-8000-0000000000d9', '2026-03-17 09:00:00-07',
        '2026-03-17 12:00:00-07', gen_random_uuid());
insert into public.timesheets (org_id, user_id, period_start, status, approver_id, approved_at)
values (:org, :erin, '2026-03-02', 'approved', :max, now());

-- Who may import -----------------------------------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[2],"action":"create",
    "email":"erin@acme.test","start_at":"2026-03-16T09:00:00-07:00","end_at":"2026-03-16T10:00:00-07:00",
    "project":null,"client":null,"task":null,"note":null,"reason":"Imported"}]')),
  '42501', 'admin_only', 'a manager can''t import time entries');
select throws_ok($$ select public.import_time_entries_context(array['erin@acme.test'], '2026-03-16', '2026-03-16') $$,
  '42501', 'admin_only', 'nor read the import context');
select pg_temp.act_as(:erin);
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[2],"action":"create",
    "email":"erin@acme.test","start_at":"2026-03-16T09:00:00-07:00","end_at":"2026-03-16T10:00:00-07:00",
    "project":null,"client":null,"task":null,"note":null,"reason":"Imported"}]')),
  '42501', 'admin_only', 'an employee can''t import time entries, not even their own');

-- An admin imports: pending for Erin (she has a manager), approved for Ada (TS-16) --------------

select pg_temp.act_as(:ada);
select is(
  public.import_apply(pg_temp.payload('[
    {"rows":[2],"action":"create","email":"Erin@acme.test","start_at":"2026-03-16T09:00:00-07:00",
     "end_at":"2026-03-16T12:30:15-07:00","project":"website revamp","client":"Northwind","task":"design",
     "note":"Wireframes","reason":"Logged in Toggl"},
    {"rows":[3],"action":"create","email":"admin@acme.test","start_at":"2026-03-16T09:00:00-04:00",
     "end_at":"2026-03-16T10:00:00-04:00","project":null,"client":null,"task":null,"note":null,
     "reason":"Imported"}]')),
  '{"kind":"time_entries","created":2,"updated":0,"unchanged":0}'::jsonb,
  'an admin imports time entries and gets the counts');

select pg_temp.act_as_postgres();
create temp table erin_entry as
select * from public.manual_entries where user_id = :erin and start_at = '2026-03-16 09:00:00-07';
select is(
  (select (e.status, e.end_at - e.start_at, e.project_id, t.name, e.note, e.reason, e.decided_at is null)::text
   from erin_entry e join public.project_tasks t on t.id = e.task_id),
  '(pending,03:30:15,00000000-0000-4000-8000-0000000000f1,Design,Wireframes,"Logged in Toggl",t)',
  'Erin''s entry is pending, to the second, with its project, task, note and reason');
select is(
  (select (status, decided_by)::text from public.manual_entries where user_id = :ada),
  '(approved,00000000-0000-4000-8000-0000000000a1)',
  'the owner, who needs no approval, is approved at once as a request would be');
select is(
  (select (actor_id, target_user_id, metadata ->> 'import', metadata ->> 'task_id' is not null)::text
   from public.audit_log where action = 'manual_entry.requested'
     and metadata ->> 'entry_id' = (select id::text from erin_entry)),
  '(00000000-0000-4000-8000-0000000000a1,00000000-0000-4000-8000-0000000000c1,true,t)',
  'each entry is audited as a request: the admin as actor, the person as target, marked import');
select is(
  (select count(*)::int from public.audit_log where action = 'manual_entry.auto_approved'
     and target_user_id = :ada and metadata ->> 'import' = 'true'),
  1, 'an auto-approved entry is audited as auto-approved');
select is(
  (select count(*)::int from public.audit_log where action = 'manual_entry.auto_approved'
     and target_user_id = :erin),
  0, 'a pending one is not');
select is(
  (select metadata from public.audit_log where action = 'import.applied'),
  '{"kind":"time_entries","created":2,"updated":0,"unchanged":0,"rows":2}'::jsonb,
  'the import is audited with its counts');

-- Re-import -----------------------------------------------------------------------------------

select pg_temp.act_as(:ada);
select is(
  public.import_apply(pg_temp.payload('[
    {"rows":[2],"action":"create","email":"erin@acme.test","start_at":"2026-03-16T16:00:00Z",
     "end_at":"2026-03-16T19:30:15Z","project":"Website revamp","client":"northwind","task":"Design",
     "note":" Wireframes ","reason":"Logged in Toggl"},
    {"rows":[3],"action":"create","email":"admin@acme.test","start_at":"2026-03-16T09:00:00-04:00",
     "end_at":"2026-03-16T10:00:00-04:00","project":null,"client":null,"task":null,"note":null,
     "reason":"Imported"}]')),
  '{"kind":"time_entries","created":0,"updated":0,"unchanged":2}'::jsonb,
  're-importing the same rows changes nothing');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.manual_entries), 2, 'no entry is added twice');
select is((select count(*)::int from public.audit_log where action = 'manual_entry.requested'), 2,
  'nor audited twice');
select pg_temp.act_as(:ada);
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[2],"action":"create",
    "email":"erin@acme.test","start_at":"2026-03-16T09:00:00-07:00","end_at":"2026-03-16T12:30:15-07:00",
    "project":"Website revamp","client":"Northwind","task":"Design","note":"Something else",
    "reason":"Logged in Toggl"}]')),
  '23505', 'entry_exists', 'the same times with other details are refused: imports don''t change entries');

-- The request rules -------------------------------------------------------------------------

select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[4],"action":"create",
    "email":"erin@acme.test","start_at":"2026-03-16T12:00:00-07:00","end_at":"2026-03-16T13:00:00-07:00",
    "project":null,"client":null,"task":null,"note":null,"reason":"Imported"}]')),
  '23P01', 'overlaps_manual_entry', 'an entry overlapping another entry is refused');
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[4],"action":"create",
    "email":"erin@acme.test","start_at":"2026-03-17T11:00:00-07:00","end_at":"2026-03-17T13:00:00-07:00",
    "project":null,"client":null,"task":null,"note":null,"reason":"Imported"}]')),
  '23P01', 'overlaps_clocked_time', 'an entry overlapping clocked time is refused');
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[4],"action":"create",
    "email":"erin@acme.test","start_at":"2026-03-04T09:00:00-08:00","end_at":"2026-03-04T10:00:00-08:00",
    "project":null,"client":null,"task":null,"note":null,"reason":"Imported"}]')),
  '55000', 'day_locked', 'an entry in an approved week is refused');
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[4],"action":"create",
    "email":"lucas@acme.test","start_at":"2026-03-16T09:00:00-05:00","end_at":"2026-03-16T10:00:00-05:00",
    "project":"Internal","client":null,"task":null,"note":null,"reason":"Imported"}]')),
  '22023', 'project_not_allowed', 'a project the person can''t log to is refused');
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[4],"action":"create",
    "email":"erin@acme.test","start_at":"2026-03-18T09:00:00-07:00","end_at":"2026-03-18T10:00:00-07:00",
    "project":"Internal","client":null,"task":"Design","note":null,"reason":"Imported"}]')),
  '22023', 'task_not_found', 'a task of another project is refused');
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[4],"action":"create",
    "email":"erin@acme.test","start_at":"2026-03-18T09:00:00-07:00","end_at":"2026-03-18T10:00:00-07:00",
    "project":"Website revamp","client":"Northwind","task":"Old work","note":null,"reason":"Imported"}]')),
  '22023', 'task_not_allowed', 'an archived task is refused');
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload(format('[{"rows":[4],"action":"create",
    "email":"erin@acme.test","start_at":"%s","end_at":"%s",
    "project":null,"client":null,"task":null,"note":null,"reason":"Imported"}]',
    now() - interval '1 hour', now() + interval '1 hour'))),
  '22023', 'in_the_future', 'time that hasn''t happened yet is refused');
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[4],"action":"create",
    "email":"erin@acme.test","start_at":"2026-03-18T09:00:00-07:00","end_at":"2026-03-19T10:00:00-07:00",
    "project":null,"client":null,"task":null,"note":null,"reason":"Imported"}]')),
  '22023', 'range_too_long', 'an entry over 24 hours is refused');

-- All or nothing ------------------------------------------------------------------------------

select is(
  pg_temp.detail_of(format('select public.import_apply(%L)', pg_temp.payload('[
    {"rows":[2],"action":"create","email":"lucas@acme.test","start_at":"2026-03-19T09:00:00-05:00",
     "end_at":"2026-03-19T10:00:00-05:00","project":null,"client":null,"task":null,"note":null,"reason":"Imported"},
    {"rows":[3],"action":"create","email":"erin@acme.test","start_at":"2026-03-17T08:00:00-07:00",
     "end_at":"2026-03-17T10:00:00-07:00","project":null,"client":null,"task":null,"note":null,"reason":"Imported"}]'))),
  'rows: 3', 'a failing entry names its row in DETAIL');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.manual_entries where user_id = :lucas), 0,
  'and the file''s other entries aren''t written');
select is((select count(*)::int from public.audit_log where action = 'import.applied'), 2,
  'failed imports aren''t audited as applied');

-- request_manual_entry is unchanged for the person themselves --------------------------------

select pg_temp.act_as(:erin);
create temp table own as
select public.request_manual_entry('2026-03-18 14:00:00-07', '2026-03-18 15:00:00-07', :revamp,
  ' Client visit ', null, '  Notes  ') as id;
grant select on own to authenticated;
select is(
  (select (status, reason, note)::text from public.manual_entries where id = (select id from own)),
  '(pending,"Client visit",Notes)', 'a request still trims its reason and note and waits for approval');
select pg_temp.act_as_postgres();
select is(
  (select (actor_id, target_user_id, metadata ? 'import')::text from public.audit_log
   where action = 'manual_entry.requested' and metadata ->> 'entry_id' = (select id::text from own)),
  '(00000000-0000-4000-8000-0000000000c1,00000000-0000-4000-8000-0000000000c1,f)',
  'and is audited with the person as actor, without the import mark');
select pg_temp.act_as(:erin);
select throws_ok($$ select public.request_manual_entry('2026-03-17 11:00:00-07', '2026-03-17 13:00:00-07', null, 'x') $$,
  '23P01', 'overlaps_clocked_time', 'and still refuses an overlap');

-- The preview's context ---------------------------------------------------------------------

select pg_temp.act_as(:ada);
create temp table ctx as
select public.import_time_entries_context(array['ERIN@acme.test', 'nobody@acme.test'], '2026-03-04', '2026-03-17') as v;
select is(
  (select jsonb_agg(e ->> 'reason' order by e ->> 'start_at') from ctx, jsonb_array_elements(v -> 'entries') e),
  '["Logged in Toggl", "Client visit"]'::jsonb, 'the context lists the people''s entries around the dates');
select is(
  (select (v -> 'entries' -> 0) - 'start_at' - 'end_at' from ctx),
  '{"email":"erin@acme.test","status":"pending","project":"Website revamp","client":"Northwind",
    "task":"Design","note":"Wireframes","reason":"Logged in Toggl"}'::jsonb,
  'by name, with their status');
select is(
  (select jsonb_build_object('clocked', jsonb_array_length(v -> 'clocked'), 'locked', v -> 'locked') from ctx),
  '{"clocked":1,"locked":[{"email":"erin@acme.test","period_start":"2026-03-02"}]}'::jsonb,
  'their clocked time and approved weeks');

select * from finish();
rollback;
