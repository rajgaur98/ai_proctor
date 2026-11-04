-- #306 (API-01..05, AUD-01): org API keys and the public API's database side.
begin;
create extension if not exists pgtap with schema extensions;

select plan(66);

\set org '''00000000-0000-4000-8000-000000000001'''
\set org2 '''00000000-0000-4000-8000-000000000002'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''
\set olga '''00000000-0000-4000-8000-0000000000a9'''
\set oscar '''00000000-0000-4000-8000-0000000000c9'''
\set dev '''00000000-0000-4000-8000-0000000000d7'''

insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into auth.users (id, email) values (:olga, 'olga@other.test'), (:oscar, 'oscar@other.test');
insert into public.users (id, org_id, full_name, email, role, manager_id) values
  (:olga, :org2, 'Olga Owner', 'olga@other.test', 'owner', null),
  (:oscar, :org2, 'Oscar Employee', 'oscar@other.test', 'employee', :olga);

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

-- The api-v1 Edge Function's role.
create function pg_temp.as_service() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select set_config('role', 'service_role', true);
$$;

create function pg_temp.as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

create function pg_temp.iso(t timestamptz) returns text
language sql as $$ select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') $$;

-- Monday of last week (Los Angeles) at a local time.
create function pg_temp.last_monday(t interval) returns timestamptz
language sql as $$
  select (date_trunc('week', now() at time zone 'America/Los_Angeles') - interval '7 days' + t)
    at time zone 'America/Los_Angeles'
$$;

create function pg_temp.hash(p_key text) returns text
language sql as $$ select encode(extensions.digest(convert_to(p_key, 'UTF8'), 'sha256'), 'hex') $$;

-- Keys made in this test, by name.
create temp table made (name text primary key, id uuid, key text) on commit drop;
grant all on made to authenticated, service_role;

-- Creating, listing, revoking ------------------------------------------------------------------

select pg_temp.act_as(:ada);
insert into made select 'full', id, key from public.create_api_key('  Payroll sync  ',
  array['people:read', 'teams:read', 'projects:read', 'projects:write', 'time:read', 'time:write',
        'checkins:read', 'reports:read', 'timesheets:read', 'alerts:read', 'shifts:read']);
insert into made select 'people', id, key from public.create_api_key('People only', array['people:read', 'people:read']);

select matches((select key from made where name = 'full'), '^aip_[A-Za-z0-9_-]{43}$',
  'a key is aip_ and 43 base64url characters');
select results_eq(
  $$ select name, key_prefix, scopes from public.list_api_keys() where id = (select id from made where name = 'people') $$,
  $$ values ('People only'::text, (select left(key, 8) from made where name = 'people'), array['people:read']) $$,
  'the list shows the name, the prefix and the scopes (once each)'
);
select is((select name from public.list_api_keys() where id = (select id from made where name = 'full')),
  'Payroll sync', 'the name is trimmed');
select ok(
  not exists (select 1 from public.list_api_keys() l, made m where to_jsonb(l)::text like '%' || m.key || '%'),
  'the list never returns a key'
);
select throws_ok($$ select * from public.create_api_key('x', array['captures:read']) $$,
  '22023', 'invalid_scopes', 'an unknown scope is refused');
select throws_ok($$ select * from public.create_api_key('x', array[]::text[]) $$,
  '22023', 'invalid_scopes', 'a key needs a scope');
select throws_ok($$ select * from public.create_api_key('  ', array['people:read']) $$,
  '22023', 'invalid_name', 'a key needs a name');
select throws_ok($$ select * from public.create_api_key('x', array['people:read'], now() - interval '1 minute') $$,
  '22023', 'invalid_expiry', 'an expiry in the past is refused');
select throws_ok($$ select * from public.api_keys $$, '42501', null,
  'the table is closed to dashboard users');

select pg_temp.act_as(:max);
select throws_ok($$ select * from public.create_api_key('Mine', array['people:read']) $$,
  '42501', 'admin_only', 'a manager can''t make a key');
select throws_ok($$ select * from public.list_api_keys() $$, '42501', 'admin_only',
  'nor list them');
select throws_ok($$ select public.revoke_api_key((select id from made where name = 'full')) $$,
  '42501', 'admin_only', 'nor revoke one');

select pg_temp.act_as(:olga);
select throws_ok($$ select public.revoke_api_key((select id from made where name = 'full')) $$,
  '42501', 'key_not_found', 'another org''s admin can''t revoke it');
select is((select count(*)::int from public.list_api_keys()), 0, 'nor see it');
insert into made select 'other', id, key from public.create_api_key('Other org', array['people:read', 'projects:write']);

select pg_temp.as_postgres();
select is(
  (select k.key_hash from public.api_keys k join made m on m.id = k.id where m.name = 'full'),
  (select extensions.digest(convert_to(key, 'UTF8'), 'sha256') from made where name = 'full'),
  'only the SHA-256 of the key is stored'
);
select is(
  (select metadata - 'key_id' from public.audit_log where action = 'api_key.created'
     and metadata ->> 'key_id' = (select id::text from made where name = 'people')),
  jsonb_build_object('name', 'People only', 'prefix', (select left(key, 8) from made where name = 'people'),
    'scopes', jsonb_build_array('people:read'), 'expires_at', null),
  'making a key is audit-logged, without the key'
);

-- Who can call the request RPCs -------------------------------------------------------------------

select ok(not has_function_privilege('authenticated', 'public.api_v1_authenticate(text)', 'execute'),
  'dashboard users can''t authenticate keys');
select ok(not has_function_privilege('anon', 'public.api_v1_call(uuid, text, jsonb)', 'execute'),
  'nor can anonymous callers make API calls');
select ok(not has_function_privilege('authenticated', 'internal.api_dispatch(text, jsonb, jsonb)', 'execute'),
  'nor reach the read layer directly');
select ok(has_function_privilege('service_role', 'public.api_v1_call(uuid, text, jsonb)', 'execute'),
  'the Edge Function can');

-- Authenticating ----------------------------------------------------------------------------------

select pg_temp.as_service();
select is(public.api_v1_authenticate('nope') -> 'body' -> 'error' ->> 'code', 'invalid_key',
  'a malformed hash is refused');
select is(public.api_v1_authenticate(pg_temp.hash('aip_' || repeat('x', 43))) ->> 'status', '401',
  'an unknown key is refused');
select is(
  public.api_v1_authenticate((select pg_temp.hash(key) from made where name = 'full')) - 'rate',
  jsonb_build_object('status', 200, 'key_id', (select id from made where name = 'full')),
  'a good key passes'
);
select is(
  public.api_v1_authenticate((select pg_temp.hash(key) from made where name = 'full')) -> 'rate' ->> 'remaining',
  '118', 'each request counts against the minute'
);

select pg_temp.as_postgres();
update public.api_keys set rate_window = date_trunc('minute', now()), rate_count = internal.api_rate_limit()
where id = (select id from made where name = 'people');
select pg_temp.as_service();
select is(
  (select r -> 'body' -> 'error' ->> 'code' || ' ' || (r ->> 'status') || ' ' || ((r ->> 'retry_after')::int between 1 and 60)::text
   from public.api_v1_authenticate((select pg_temp.hash(key) from made where name = 'people')) r),
  'rate_limited 429 true', 'over the limit: 429 with when to retry'
);
select pg_temp.as_postgres();
update public.api_keys set rate_window = date_trunc('minute', now()) - interval '1 minute'
where id = (select id from made where name = 'people');
select pg_temp.as_service();
select is(public.api_v1_authenticate((select pg_temp.hash(key) from made where name = 'people')) ->> 'status',
  '200', 'a new minute starts a new count');

-- Scopes and errors --------------------------------------------------------------------------------

select is(public.api_v1_call((select id from made where name = 'people'), 'teams.list', '{}') -> 'body' -> 'error' ->> 'code',
  'insufficient_scope', 'a key without the scope is refused');
select is(public.api_v1_call((select id from made where name = 'full'), 'captures.list', '{}') ->> 'status',
  '404', 'an unknown operation is a 404');
select is(public.api_v1_call((select id from made where name = 'full'), 'people.list', '{"bogus": 1}') -> 'body' -> 'error',
  '{"code": "invalid_param", "param": "bogus", "message": "bogus: unknown parameter"}'::jsonb,
  'an unknown parameter is named');
select is(public.api_v1_call((select id from made where name = 'full'), 'people.list', '{"updated_since": "2026-01-01"}') -> 'body' -> 'error' ->> 'param',
  'updated_since', 'a time needs its zone');

-- Reads -----------------------------------------------------------------------------------------

select is(
  (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(
     public.api_v1_call((select id from made where name = 'full'), 'people.list', '{}') -> 'body' -> 'data') e),
  array[:ada, :max, :erin, :lucas]::text[],
  'a key sees its own org''s people'
);
select is(
  (select array_agg(e ->> 'id') from jsonb_array_elements(
     public.api_v1_call((select id from made where name = 'other'), 'people.list', '{}') -> 'body' -> 'data') e),
  array[:olga, :oscar]::text[],
  'and another org''s key only that org''s'
);
select is(
  (select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(
     public.api_v1_call((select id from made where name = 'full'), 'people.list', '{"role": "employee", "active": "true"}') -> 'body' -> 'data') e),
  array[:erin, :lucas]::text[], 'filters apply'
);

-- Paging: two at a time, then the rest.
create temp table page1 on commit drop as
  select public.api_v1_call((select id from made where name = 'full'), 'people.list', '{"limit": 2}') -> 'body' as b;
grant all on page1 to service_role;
select is(jsonb_array_length((select b -> 'data' from page1)), 2, 'a page holds limit items');
select isnt((select b ->> 'next_cursor' from page1), null, 'with a cursor for the next');
select is(
  (select jsonb_array_length(r -> 'data') || ' ' || coalesce(r ->> 'next_cursor', 'end')
   from (select public.api_v1_call((select id from made where name = 'full'), 'people.list',
           jsonb_build_object('limit', 2, 'cursor', (select b ->> 'next_cursor' from page1))) -> 'body' as r) x),
  '2 end', 'the next page has the rest and no cursor'
);
select is(
  (select count(distinct e ->> 'id')::int from (
     select jsonb_array_elements(b -> 'data') e from page1
     union all
     select jsonb_array_elements(public.api_v1_call((select id from made where name = 'full'), 'people.list',
       jsonb_build_object('limit', 2, 'cursor', (select b ->> 'next_cursor' from page1))) -> 'body' -> 'data')) x),
  4, 'no one twice, no one missed'
);

-- Writes ----------------------------------------------------------------------------------------

select is(
  (select (r ->> 'status') || ' ' || (r -> 'body' -> 'data' ->> 'name')
   from public.api_v1_call((select id from made where name = 'full'), 'clients.create', '{"name": "  Contoso  "}') r),
  '201 Contoso', 'a client is created through save_client'
);
select is(
  public.api_v1_call((select id from made where name = 'full'), 'clients.create', '{"name": "contoso"}') -> 'body' -> 'error' ->> 'code',
  'name_taken', 'its rules apply'
);
select is(
  (select r -> 'body' -> 'data' ->> 'archived'
   from public.api_v1_call((select id from made where name = 'full'), 'clients.archive',
     jsonb_build_object('id', (select id from public.clients where name = 'Contoso'))) r),
  'true', 'and archived'
);
select is(
  public.api_v1_call((select id from made where name = 'other'), 'clients.archive',
    jsonb_build_object('id', (select id from public.clients where name = 'Contoso'))) ->> 'status',
  '404', 'another org''s key can''t touch it'
);
select is(
  public.api_v1_call((select id from made where name = 'people'), 'clients.create', '{"name": "Nope"}') ->> 'status',
  '403', 'a write needs a write scope'
);

-- A manual entry for Erin (who needs Max's approval), from last week's Monday afternoon.
create temp table entry on commit drop as
  select public.api_v1_call((select id from made where name = 'full'), 'manual_entries.create',
    jsonb_build_object('user_id', :erin, 'project_id', :revamp, 'reason', 'Client visit',
      'start_at', pg_temp.iso(pg_temp.last_monday('13 hours')),
      'end_at', pg_temp.iso(pg_temp.last_monday('14 hours 9 seconds')))) as r;
grant all on entry to service_role;
select is((select (r ->> 'status') || ' ' || (r -> 'body' -> 'data' ->> 'status') || ' ' || (r -> 'body' -> 'data' ->> 'duration_s')
  from entry), '201 pending 3609', 'a manual entry is pending for the manager, in exact seconds');
select is(
  public.api_v1_call((select id from made where name = 'full'), 'manual_entries.create',
    jsonb_build_object('user_id', :erin, 'reason', 'Again',
      'start_at', (select r -> 'body' -> 'data' ->> 'start_at' from entry),
      'end_at', (select r -> 'body' -> 'data' ->> 'end_at' from entry))) -> 'body' -> 'error' ->> 'code',
  'overlaps_manual_entry', 'the overlap rule applies (TS-09)'
);
select is(
  public.api_v1_call((select id from made where name = 'other'), 'manual_entries.create',
    jsonb_build_object('user_id', :erin, 'reason', 'x', 'start_at', '2026-01-05T13:00:00Z',
      'end_at', '2026-01-05T14:00:00Z')) ->> 'status',
  '403', 'a key without time:write can''t make one'
);

select pg_temp.as_postgres();
select results_eq(
  $$ select actor_id, target_user_id, metadata ->> 'key_id', metadata ->> 'operation'
     from public.audit_log where action = 'manual_entry.requested'
       and metadata ->> 'entry_id' = (select r -> 'body' -> 'data' ->> 'id' from entry) $$,
  $$ values ('00000000-0000-4000-8000-0000000000a1'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid, (select id::text from made where name = 'full'), 'manual_entries.create') $$,
  'the manual-entry rules log the key''s creator as actor, with the key'
);
select is(
  (select (metadata -> 'params') - 'start_at' - 'end_at' from public.audit_log where action = 'api.write'
     and metadata ->> 'operation' = 'manual_entries.create'),
  jsonb_build_object('user_id', :erin, 'project_id', :revamp),
  'the write is logged without its reason'
);
select is(
  (select metadata - 'key_id' - 'prefix' from public.audit_log where action = 'api.read'
     and metadata ->> 'operation' = 'people.list' and metadata -> 'filters' ? 'role'),
  jsonb_build_object('key_name', 'Payroll sync', 'operation', 'people.list',
    'filters', jsonb_build_object('role', 'employee', 'active', 'true'), 'row_count', 2),
  'a read is logged like an export: the key, the filters and the row count'
);
select is(
  (select count(*)::int from public.audit_log where action = 'api.read' and metadata -> 'filters' ? 'cursor'),
  0, 'the cursor isn''t a filter'
);
select is((select count(*)::int from public.audit_log where action like 'api.%' and metadata ->> 'operation' = 'teams.list'),
  0, 'a refused call writes no audit row');

-- Check-ins: metadata only (API-04) ---------------------------------------------------------------

insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values (:dev, :org, :erin, 'macos', '15', 'test', 'api-test');
insert into public.checkin_events (id, org_id, user_id, device_id, project_id, scheduled_at, shown_at,
  responded_at, outcome, response_ms, object_keys, missed_reason, flags)
values ('00000000-0000-4000-8000-00000000ce01', :org, :erin, :dev, :revamp, now() - interval '2 hours',
  now() - interval '119 minutes', now() - interval '119 minutes' + interval '2 seconds', 'pass', 2000,
  array['org/erin/screen.webp'], 'my own words', array['fast_response']);

select pg_temp.as_service();
select is(
  (select array_agg(k order by k) from jsonb_object_keys(
     public.api_v1_call((select id from made where name = 'full'), 'checkins.list',
       jsonb_build_object('user_id', :erin)) -> 'body' -> 'data' -> 0) k),
  array['created_at', 'id', 'outcome', 'project_id', 'responded_at', 'response_ms', 'shown_at',
        'updated_at', 'user_id'],
  'a check-in is its outcome, times and response time only'
);
select ok(
  public.api_v1_call((select id from made where name = 'full'), 'checkins.list', '{}')::text
    !~ 'screen\.webp|my own words|fast_response|scheduled',
  'never captures, the person''s words, flags or the scheduled time'
);
select pg_temp.as_postgres();
delete from public.checkin_events where id = '00000000-0000-4000-8000-00000000ce01';
select pg_temp.as_service();
select is(
  jsonb_array_length(public.api_v1_call((select id from made where name = 'full'), 'checkins.list', '{}') -> 'body' -> 'data'),
  0, 'deleted or purged data is gone from the API'
);

-- Reports include the key's creator -----------------------------------------------------------------

select ok(
  public.api_v1_call((select id from made where name = 'full'), 'reports.people',
    jsonb_build_object('from', (now() at time zone 'America/Los_Angeles')::date - 7, 'to', (now() at time zone 'America/Los_Angeles')::date)) -> 'body' -> 'data' @> jsonb_build_array(jsonb_build_object('user_id', :ada)),
  'a report covers the whole org, the creator too'
);
select is(
  public.api_v1_call((select id from made where name = 'full'), 'reports.tasks', '{"from": "2026-01-05"}') -> 'body' -> 'error' ->> 'param',
  'to', 'a report needs both days'
);

-- The key stops with its creator --------------------------------------------------------------------

select pg_temp.as_postgres();
update public.users set role = 'manager' where id = :olga;
select pg_temp.as_service();
select is(public.api_v1_authenticate((select pg_temp.hash(key) from made where name = 'other')) -> 'body' -> 'error' ->> 'code',
  'key_creator_inactive', 'a key stops when its creator is no longer an owner or admin');

select pg_temp.as_postgres();
update public.api_keys set expires_at = now() - interval '1 second' where id = (select id from made where name = 'people');
select pg_temp.as_service();
select is(public.api_v1_authenticate((select pg_temp.hash(key) from made where name = 'people')) -> 'body' -> 'error' ->> 'code',
  'key_expired', 'an expired key is refused');

select pg_temp.as_postgres();
select pg_temp.act_as(:ada);
select lives_ok($$ select public.revoke_api_key((select id from made where name = 'full')) $$, 'revoke');
select lives_ok($$ select public.revoke_api_key((select id from made where name = 'full')) $$, 'twice is a no-op');
select pg_temp.as_service();
select is(public.api_v1_authenticate((select pg_temp.hash(key) from made where name = 'full')) -> 'body' -> 'error' ->> 'code',
  'key_revoked', 'a revoked key is refused');
select is(public.api_v1_call((select id from made where name = 'full'), 'people.list', '{}') ->> 'status',
  '401', 'at once, even mid-request');
select pg_temp.as_postgres();
select is((select count(*)::int from public.audit_log where action = 'api_key.revoked'
  and metadata ->> 'key_id' = (select id::text from made where name = 'full')), 1, 'revoking is logged once');

-- updated_at ------------------------------------------------------------------------------------

alter table public.users disable trigger users_touch_updated_at;
update public.users set updated_at = '2020-01-01' where id = :lucas;
alter table public.users enable trigger users_touch_updated_at;
update public.users set config_version = config_version + 1 where id = :lucas;
select is((select updated_at from public.users where id = :lucas), '2020-01-01'::timestamptz,
  'a tray config bump isn''t a change for syncing');
update public.users set work_state = 'NV' where id = :lucas;
select is((select updated_at from public.users where id = :lucas), now(), 'a real change moves updated_at');

-- Deleting the creator deletes their keys --------------------------------------------------------

select is((select count(*)::int from public.api_keys where created_by = :olga), 1, 'Olga has a key');
delete from public.users where id = :olga;
select is((select count(*)::int from public.api_keys where created_by = :olga), 0, 'it goes with her');

select * from finish();
rollback;
