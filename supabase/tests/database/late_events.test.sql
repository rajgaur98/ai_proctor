begin;
create extension if not exists pgtap with schema extensions;

select plan(37);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set mia '''00000000-0000-4000-8000-0000000000d1'''
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

create function pg_temp.dirty(uid uuid) returns text
language sql as $$
  select coalesce(string_agg(day::text, ',' order by day), '') from public.dirty_days where user_id = uid
$$;

-- Notifications of one kind for one timesheet, read as the owner.
create function pg_temp.notified(uid uuid, k text, ts uuid) returns int
language sql security definer as $$
  select count(*)::int from public.notifications
  where user_id = uid and kind = k and payload ->> 'timesheet_id' = ts::text
$$;

-- Erin is in America/Los_Angeles (PDT, -07, from 8 March 2026), Lucas in America/Chicago.
create temp table dev as
with d as (
  insert into public.devices (org_id, user_id, platform, os_version, agent_version, hardware_hash)
  values (:org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-late'),
         (:org, :lucas, 'macos', '26.0', '0.1.0', 'hash-lucas-late') returning id, user_id
)
select id, user_id from d;

create function pg_temp.session(uid uuid, start_at timestamptz, end_at timestamptz)
returns uuid
language sql as $$
  insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
  values ('00000000-0000-4000-8000-000000000001', uid,
          (select id from dev where user_id = uid), start_at, end_at, gen_random_uuid())
  returning id
$$;

-- Mia is Max's delegate now (as the delegation tests do); Ada is the owner above Max.
insert into auth.users (id, email) values (:mia, 'mia@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id)
values (:mia, :org, 'Mia Manager', 'mia@acme.test', 'manager', :ada);
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org, :max, :mia, current_date - 2, current_date + 30);

-- Erin's week of 16 March is submitted and approved (nothing flagged, nothing pending).
select pg_temp.act_as(:erin);
create temp table ts as select public.ensure_timesheet(:erin, '2026-03-16') as id;
grant select on ts to authenticated;
select public.submit_timesheet((select id from ts));
select pg_temp.act_as(:max);
select public.approve_timesheet((select id from ts));
select pg_temp.act_as_postgres();
delete from public.dirty_days;

select is(
  (select (status, late_data_at is null, late_data_last_at is null, late_data_count)::text
   from public.timesheets where id = (select id from ts)),
  '(approved,t,t,0)', 'approved: no late data to start with');

-- A late fact ---------------------------------------------------------------------------------

create temp table s1 as select pg_temp.session(:erin, '2026-03-17 09:00:00-07', '2026-03-17 10:00:00-07') as id;
select is(
  (select (late_data_at is not null, late_data_last_at = late_data_at, late_data_count)::text
   from public.timesheets where id = (select id from ts)),
  '(t,t,1)', 'late: a clock session in an approved day flags the week');
select is(
  (select (status, approver_id, approved_at is not null)::text from public.timesheets where id = (select id from ts)),
  '(approved,00000000-0000-4000-8000-0000000000b1,t)', 'late: the approval is untouched (TS-18)');
select is(internal.replace_day_segments(:erin, '2026-03-17', '[]'::jsonb), null,
  'late: the rebuild still leaves the locked day alone');
select is((select count(*)::int from public.time_segments where user_id = :erin and day = '2026-03-17'), 0,
  'late: so the approved numbers do not move');
select is(pg_temp.notified(:max, 'timesheet.late_data', (select id from ts)), 1,
  'notify: the direct manager is told, once');
select is(pg_temp.notified(:mia, 'timesheet.late_data', (select id from ts)), 1,
  'notify: so is the active delegate');
select is(pg_temp.notified(:ada, 'timesheet.late_data', (select id from ts)), 0,
  'notify: an owner who is not the approver is not');
select is(pg_temp.notified(:erin, 'timesheet.late_data', (select id from ts)), 0,
  'notify: nor the employee');
select is(
  (select payload ->> 'employee_id' || '/' || (payload ->> 'period_start') || '/' || (payload ->> 'period_end')
   from public.notifications where user_id = :max and kind = 'timesheet.late_data'),
  '00000000-0000-4000-8000-0000000000c1/2026-03-16/2026-03-22', 'notify: it names the employee and the week');

-- More late facts do not notify again -------------------------------------------------------------

create temp table first_at as select late_data_at as at from public.timesheets where id = (select id from ts);
select pg_sleep(0.01);
create temp table s2 as select pg_temp.session(:erin, '2026-03-18 09:00:00-07', '2026-03-18 10:00:00-07') as id;
select is(
  (select (late_data_at = (select at from first_at), late_data_last_at > late_data_at, late_data_count)::text
   from public.timesheets where id = (select id from ts)),
  '(t,t,2)', 'repeat: the first time stays, the last time and count move');
select is(pg_temp.notified(:max, 'timesheet.late_data', (select id from ts)), 1, 'repeat: no second notification for the manager');
select is(pg_temp.notified(:mia, 'timesheet.late_data', (select id from ts)), 1, 'repeat: nor for the delegate');
select ok(pg_temp.dirty(:erin) like '%2026-03-18%',
  'repeat: the fact is still marked dirty, as before (the earlier mark went with the locked rebuild)');

-- Who sees it --------------------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is((select late_data_count from public.timesheets where id = (select id from ts)), 2,
  'RLS: the employee reads the flag on her own week');
select pg_temp.act_as(:max);
select is((select late_data_count from public.timesheets where id = (select id from ts)), 2,
  'RLS: so does the manager');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.timesheets where late_data_count > 0), 0,
  'RLS: a peer sees nothing');

-- Weeks that are not approved are unaffected -------------------------------------------------------

select pg_temp.act_as(:erin);
create temp table draft as select public.ensure_timesheet(:erin, '2026-03-23') as id;
create temp table submitted as select public.ensure_timesheet(:erin, '2026-03-09') as id;
grant select on draft, submitted to authenticated;
select public.submit_timesheet((select id from submitted));
select pg_temp.act_as_postgres();
create temp table s3 as select pg_temp.session(:erin, '2026-03-24 09:00:00-07', '2026-03-24 10:00:00-07') as id;
create temp table s4 as select pg_temp.session(:erin, '2026-03-10 09:00:00-07', '2026-03-10 10:00:00-07') as id;
select is(
  (select count(*)::int from public.timesheets where id in (select id from draft union all select id from submitted)
   and (late_data_at is not null or late_data_count > 0)),
  0, 'unlocked: a draft and a submitted week are not flagged');
select is(pg_temp.notified(:max, 'timesheet.late_data', (select id from submitted)), 0, 'unlocked: and nobody is notified');
create temp table s5 as select pg_temp.session(:lucas, '2026-03-17 09:00:00-05', '2026-03-17 10:00:00-05') as id;
select is((select count(*)::int from public.timesheets where user_id = :lucas), 0,
  'unlocked: a person with no timesheet is just marked dirty, as before');
select is(
  (select late_data_count from public.timesheets where id = (select id from ts)), 2,
  'unlocked: the approved week is only flagged by its own days');

-- A session that crosses into the next, unapproved week still flags the approved days it touches ----

create temp table s6 as select pg_temp.session(:erin, '2026-03-22 22:00:00-07', '2026-03-23 02:00:00-07') as id;
select is(
  (select late_data_count from public.timesheets where id = (select id from ts)), 3,
  'span: a night shift from the approved Sunday flags the approved week');
select is(
  (select late_data_count from public.timesheets where id = (select id from draft)), 0,
  'span: the draft week it runs into is not flagged');

-- Reopening clears it, and the rebuild includes the new data ----------------------------------------

select pg_temp.act_as(:max);
select lives_ok(format($$ select public.reopen_timesheet(%L, 'New data arrived') $$, (select id from ts)),
  'reopen: the manager reopens the week');
select is(
  (select (status, late_data_at is null, late_data_last_at is null, late_data_count)::text
   from public.timesheets where id = (select id from ts)),
  '(submitted,t,t,0)', 'reopen: the late-data flag is cleared');
select pg_temp.act_as_postgres();
select is(internal.day_locked(:erin, '2026-03-17'), false, 'reopen: the day unlocks');
select ok(pg_temp.dirty(:erin) like '%2026-03-17%', 'reopen: and is marked dirty for the rebuild');
select is(
  internal.replace_day_segments(:erin, '2026-03-17', jsonb_build_array(jsonb_build_object(
    'start', extract(epoch from timestamptz '2026-03-17 09:00:00-07')::bigint,
    'end', extract(epoch from timestamptz '2026-03-17 10:00:00-07')::bigint,
    'type', 'verified', 'project_id', null, 'counted', true, 'flagged', false))),
  1, 'reopen: the rebuild takes the late data in');
select is((select count(*)::int from public.time_segments where user_id = :erin and day = '2026-03-17'), 1,
  'reopen: and the day now has it');

-- Approving again starts clean -------------------------------------------------------------------------

select pg_temp.act_as(:max);
select lives_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  're-approve: the manager approves the week again');
select is(
  (select (status, late_data_at is null, late_data_count)::text from public.timesheets where id = (select id from ts)),
  '(approved,t,0)', 're-approve: no banner, nothing late');
select pg_temp.act_as_postgres();
select is(pg_temp.notified(:max, 'timesheet.late_data', (select id from ts)), 1,
  're-approve: nothing new was sent');

-- A new episode notifies again ------------------------------------------------------------------------------

create temp table s7 as select pg_temp.session(:erin, '2026-03-19 09:00:00-07', '2026-03-19 10:00:00-07') as id;
select is(
  (select (late_data_at is not null, late_data_count)::text from public.timesheets where id = (select id from ts)),
  '(t,1)', 'again: late data after the second approval flags it afresh');
select is(pg_temp.notified(:max, 'timesheet.late_data', (select id from ts)), 2,
  'again: and tells the manager once more');
select is(pg_temp.notified(:mia, 'timesheet.late_data', (select id from ts)), 2,
  'again: and the delegate');

-- An ended delegation is not told ----------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select public.reopen_timesheet((select id from ts), 'Again');
select public.approve_timesheet((select id from ts));
select pg_temp.act_as_postgres();
update public.delegations set ended_at = now() where delegate_id = :mia;
create temp table s8 as select pg_temp.session(:erin, '2026-03-20 09:00:00-07', '2026-03-20 10:00:00-07') as id;
select is(pg_temp.notified(:max, 'timesheet.late_data', (select id from ts)), 3, 'ended: the manager is told');
select is(pg_temp.notified(:mia, 'timesheet.late_data', (select id from ts)), 2, 'ended: a delegate whose delegation ended is not');

select * from finish();
rollback;
