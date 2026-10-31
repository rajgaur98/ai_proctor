-- record_export (#255, TS-20 extended, AUD-01): the audit row of a list page's export.
begin;
create extension if not exists pgtap with schema extensions;

select plan(22);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set nora '''00000000-0000-4000-8000-0000000000f1'''
\set dan '''00000000-0000-4000-8000-0000000000f2'''
\set zed '''00000000-0000-4000-8000-0000000000f3'''
\set other '''00000000-0000-4000-8000-0000000000f9'''

create function pg_temp.act_as(uid uuid, extra jsonb default '{}'::jsonb) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    ((internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims') || extra)::text, true);
  select set_config('role', 'authenticated', true);
$$;

-- A token issued before the person was deactivated (the hook issues none after).
create function pg_temp.act_with(claims jsonb) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', claims::text, true);
  select set_config('role', 'authenticated', true);
$$;

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- Rows earlier runs left (the log is append-only) are older than this.
select coalesce(max(id), 0) as mark from public.audit_log \gset

create function pg_temp.exports(mark bigint) returns int
language sql as $$
  select count(*)::int from public.audit_log where action = 'export.created' and id > mark
$$;

-- Nora signed up but is in no org; Dan is deactivated; Zed is in another org.
select pg_temp.act_as_postgres();
insert into auth.users (id, email) values
  (:nora, 'nora@nowhere.test'), (:dan, 'dan@acme.test'), (:zed, 'zed@other.test');
insert into public.orgs (id, name, region_preset) values (:other, 'Other Co', 'us');
insert into public.users (id, org_id, full_name, email, role, manager_id, work_country, work_state, timezone, active)
values
  (:dan, :org, 'Dan Deactivated', 'dan@acme.test', 'employee', :max, 'US', 'TX', 'America/Chicago', false),
  (:zed, :other, 'Zed Elsewhere', 'zed@other.test', 'owner', null, 'US', 'NY', 'America/New_York', true);

-- Recording -----------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select lives_ok(
  $$ select public.record_export('alerts', 'xlsx', '{"kind": "Missed check-ins", "employee": "Erin Employee"}', 3) $$,
  'a manager records an export');
select pg_temp.act_as_postgres();
select results_eq(
  $$ select org_id, actor_id, actor_name, target_user_id, metadata from public.audit_log
     where action = 'export.created' order by id desc limit 1 $$,
  $$ values ('00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-0000000000b1'::uuid,
             'Max Manager', null::uuid,
             '{"page": "alerts", "format": "xlsx", "row_count": 3,
               "filters": {"kind": "Missed check-ins", "employee": "Erin Employee"}}'::jsonb) $$,
  'the row has the org, the actor, the page, the format, the filters and the row count');

select pg_temp.act_as(:ada);
select lives_ok($$ select public.record_export('people', 'csv') $$,
  'an owner records one with no filters and no rows');
select is((select metadata from public.audit_log where action = 'export.created' order by id desc limit 1),
  '{"page": "people", "format": "csv", "row_count": 0, "filters": {}}'::jsonb,
  'which are recorded as {} and 0');
select is((select count(*)::int from public.audit_log where action = 'export.created' and id > :mark), 2,
  'the owner reads both rows in the audit log');

select pg_temp.act_as(:erin);
select lives_ok($$ select public.record_export('delegations', 'csv', '{}', 1) $$,
  'an employee may record an export too (of what they can see)');
select is((select count(*)::int from public.audit_log), 0,
  'but cannot read the audit log');

-- Who is refused ---------------------------------------------------------------------------------

select pg_temp.act_as_postgres();
select is(pg_temp.exports(:mark), 3, 'three exports so far');

select pg_temp.act_as(:nora);
select throws_ok($$ select public.record_export('people', 'csv', '{}', 1) $$,
  '42501', 'user_not_provisioned', 'someone who is not a member of any org is refused');
select pg_temp.act_with(jsonb_build_object('sub', :dan, 'role', 'authenticated', 'org_id', :org));
select throws_ok($$ select public.record_export('people', 'csv', '{}', 1) $$,
  '42501', 'user_inactive', 'a deactivated member is refused, even with an older token');
select pg_temp.act_as(:zed, jsonb_build_object('org_id', '00000000-0000-4000-8000-000000000001'));
select throws_ok($$ select public.record_export('people', 'csv', '{}', 1) $$,
  '42501', 'not_a_member', 'a token for an org the caller is not in is refused');
select pg_temp.act_as(:zed);
select lives_ok($$ select public.record_export('people', 'csv', '{}', 1) $$,
  'with a token for their own org, the other org''s owner records it');
select pg_temp.act_as_postgres();
select is((select org_id from public.audit_log where action = 'export.created' order by id desc limit 1),
  '00000000-0000-4000-8000-0000000000f9'::uuid, 'in their own org''s log');
select ok(not has_function_privilege('anon', 'public.record_export(text, text, jsonb, int)', 'execute'),
  'signed-out callers cannot run it');

-- What it accepts --------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok($$ select public.record_export('People page', 'csv', '{}', 1) $$,
  '22023', 'invalid_page', 'the page is a short lower-case name');
select throws_ok($$ select public.record_export(null, 'csv', '{}', 1) $$,
  '22023', 'invalid_page', 'and is required');
select throws_ok($$ select public.record_export('people', 'pdf', '{}', 1) $$,
  '22023', 'invalid_format', 'the format is csv or xlsx');
select throws_ok($$ select public.record_export('people', 'csv', '["a"]', 1) $$,
  '22023', 'invalid_filters', 'the filters are an object');
select throws_ok(
  format($$ select public.record_export('people', 'csv', %L, 1) $$,
    jsonb_build_object('search', repeat('x', 5000))),
  '22023', 'invalid_filters', 'and a small one');
select throws_ok($$ select public.record_export('people', 'csv', '{}', -1) $$,
  '22023', 'invalid_row_count', 'the row count is not negative');
select lives_ok($$ select public.record_export('people', 'csv', null, 2) $$,
  'no filters at all is the same as {}');

select pg_temp.act_as_postgres();
select is(pg_temp.exports(:mark), 5, 'refused calls wrote nothing: only Zed''s and the last one were added');

select * from finish();
rollback;
