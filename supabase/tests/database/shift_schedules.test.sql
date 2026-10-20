begin;
create extension if not exists pgtap with schema extensions;

select plan(12);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create temp table v0 as select
  (select policy_version from public.orgs where id = '00000000-0000-4000-8000-000000000001') as policy_version,
  (select config_version from public.users where id = '00000000-0000-4000-8000-0000000000c1') as config_version;
grant select on v0 to authenticated;

select pg_temp.act_as(:lucas);
select throws_ok(
  $$ select public.set_shifts('00000000-0000-4000-8000-0000000000c1', '[]') $$,
  '42501', 'manager_or_admin_only', 'a peer cannot set someone''s shifts'
);

-- Max is Erin's direct manager: a day shift and a night shift that crosses midnight.
select pg_temp.act_as(:max);
select lives_ok(
  $$ select public.set_shifts('00000000-0000-4000-8000-0000000000c1', '[
       {"days": [5, 1, 2, 2], "start": "09:00", "end": "17:30", "timezone": "America/Los_Angeles"},
       {"days": [6], "start": "22:00", "end": "06:00", "timezone": "America/Los_Angeles"}
     ]') $$,
  'the direct manager sets the shifts, including one across midnight'
);
select results_eq(
  $$ select days, start_time::text, end_time::text from public.shifts
     where user_id = '00000000-0000-4000-8000-0000000000c1' order by start_time $$,
  $$ values (array[1, 2, 5], '09:00:00', '17:30:00'), (array[6], '22:00:00', '06:00:00') $$,
  'replaces what was there; days de-duplicated and sorted'
);
select is((select policy_version from public.orgs where id = '00000000-0000-4000-8000-000000000001'),
  (select policy_version from v0), 'the org''s policy_version does not move');
select is((select config_version from public.users where id = '00000000-0000-4000-8000-0000000000c1'),
  (select config_version + 1 from v0), 'her config_version moves so only her devices refetch');

select throws_ok(
  $$ select public.set_shifts('00000000-0000-4000-8000-0000000000c1',
       '[{"days": [1], "start": "09:00", "end": "09:00", "timezone": "UTC"}]') $$,
  '22023', 'invalid_shifts', 'a shift needs a length'
);
select throws_ok(
  $$ select public.set_shifts('00000000-0000-4000-8000-0000000000c1',
       '[{"days": [8], "start": "09:00", "end": "17:00", "timezone": "UTC"}]') $$,
  '22023', 'invalid_shifts', 'days are 1 to 7'
);
select throws_ok(
  $$ select public.set_shifts('00000000-0000-4000-8000-0000000000c1',
       '[{"days": [1], "start": "25:00", "end": "17:00", "timezone": "UTC"}]') $$,
  '22023', 'invalid_shifts', 'times must be times'
);
select throws_ok(
  $$ select public.set_shifts('00000000-0000-4000-8000-0000000000c1',
       '[{"days": [1], "start": "09:00", "end": "17:00", "timezone": "Mars/Base"}]') $$,
  '22023', 'invalid_timezone', 'time zones must exist'
);

-- An admin can too; the change is in the audit log.
select pg_temp.act_as(:ada);
select lives_ok(
  $$ select public.set_shifts('00000000-0000-4000-8000-0000000000c2',
       '[{"days": [1, 2, 3, 4, 5], "start": "08:00", "end": "16:00", "timezone": "America/Chicago"}]') $$,
  'an admin sets anyone''s shifts'
);
select is(
  (select count(*)::int from public.audit_log where action = 'member.shifts_changed'), 2,
  'every change is audit-logged'
);

-- The agent reads them.
select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-shifts');
select is(
  public.agent_config((select device_id from dev)) -> 'shifts' -> 1,
  '{"days": [6], "start": "22:00", "end": "06:00", "timezone": "America/Los_Angeles"}'::jsonb,
  'agent_config returns the person''s shifts'
);

select * from finish();
rollback;
