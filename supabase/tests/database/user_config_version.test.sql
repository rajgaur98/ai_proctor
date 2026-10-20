begin;
create extension if not exists pgtap with schema extensions;

select plan(24);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set org '''00000000-0000-4000-8000-000000000001'''
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

create function pg_temp.latest() returns uuid
language sql as $$
  select id from public.notices where org_id = '00000000-0000-4000-8000-000000000001' order by version desc limit 1
$$;

-- Versions as the server sees them: the org's, then each person's own.
create function pg_temp.org_v() returns int language sql as $$
  select policy_version from public.orgs where id = '00000000-0000-4000-8000-000000000001' $$;
create function pg_temp.user_v(uid uuid) returns int language sql as $$
  select config_version from public.users where id = uid $$;

select pg_temp.act_as(:erin);
create temp table dev_erin as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-cv');
grant select on dev_erin to authenticated;
select pg_temp.act_as(:lucas);
create temp table dev_lucas as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-lucas-cv');
grant select on dev_lucas to authenticated;

create function pg_temp.hb(dev uuid) returns jsonb language sql as $$
  select public.agent_heartbeat(dev, now(), 0, false, false, '0.1.1', '{}')
$$;
grant execute on function pg_temp.hb(uuid) to authenticated;

-- The heartbeat returns both: the org's version and the combined one ---------------------------

select pg_temp.act_as(:erin);
select is(
  (select (pg_temp.hb((select device_id from dev_erin)) ->> 'config_version')::int),
  pg_temp.org_v() + pg_temp.user_v(:erin),
  'the heartbeat returns org policy_version + her own config_version');
select is(
  (select (pg_temp.hb((select device_id from dev_erin)) ->> 'policy_version')::int), pg_temp.org_v(),
  'and still the org''s policy_version');
select is(
  (select (public.agent_config((select device_id from dev_erin)) ->> 'config_version')::int),
  (select (pg_temp.hb((select device_id from dev_erin)) ->> 'config_version')::int),
  'the config carries the same version, so the agent compares like with like');

-- An acknowledgement moves only that person's version --------------------------------------------

select pg_temp.act_as(:ada);
select lives_ok($$ select public.publish_notice(public.notice_template()) $$, 'an admin publishes a new notice');
select pg_temp.act_as_postgres();
create temp table v1 as select pg_temp.org_v() as org, pg_temp.user_v(:erin) as erin, pg_temp.user_v(:lucas) as lucas;
grant select on v1 to authenticated;

select pg_temp.act_as(:erin);
select lives_ok($$ select public.acknowledge_notice(pg_temp.latest()) $$, 'Erin acknowledges it');
select lives_ok($$ select public.acknowledge_notice(pg_temp.latest()) $$, 'doing it again changes nothing');
select pg_temp.act_as_postgres();
select is(pg_temp.org_v(), (select org from v1), 'the org''s version did not move');
select is(pg_temp.user_v(:erin), (select erin + 1 from v1), 'hers moved once');
select is(pg_temp.user_v(:lucas), (select lucas from v1), 'Lucas''s did not');

-- A policy change moves the org's, so everyone's combined version moves ------------------------------

select pg_temp.act_as(:erin);
create temp table c1 as select
  (pg_temp.hb((select device_id from dev_erin)) ->> 'config_version')::int as erin;
grant select on c1 to authenticated;
select pg_temp.act_as(:lucas);
create temp table c2 as select
  (pg_temp.hb((select device_id from dev_lucas)) ->> 'config_version')::int as lucas;
grant select on c2 to authenticated;
select pg_temp.act_as(:ada);
select lives_ok($$ select public.update_policy('{"idle_threshold_min": 14}') $$, 'an admin changes the policy');
select pg_temp.act_as(:erin);
select is((pg_temp.hb((select device_id from dev_erin)) ->> 'config_version')::int, (select erin + 1 from c1),
  'Erin''s devices see a new version');
select pg_temp.act_as(:lucas);
select is((pg_temp.hb((select device_id from dev_lucas)) ->> 'config_version')::int, (select lucas + 1 from c2),
  'and so do Lucas''s');

-- Shifts, projects and time zone move only the people they touch -------------------------------------

select pg_temp.act_as_postgres();
create temp table v2 as select pg_temp.org_v() as org, pg_temp.user_v(:erin) as erin, pg_temp.user_v(:lucas) as lucas;
grant select on v2 to authenticated;

select pg_temp.act_as(:max);
select public.set_shifts(:erin, '[{"days": [1], "start": "09:00", "end": "17:00", "timezone": "UTC"}]');
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v2),
  array[0, 1, 0], 'shifts: only the person whose shifts changed');

select pg_temp.act_as(:max);
create temp table made as select public.save_project(null, 'Mobile app') as id;
grant select on made to authenticated;
select public.set_project_members((select id from made), array[:erin::uuid]);
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v2),
  array[0, 2, 0], 'projects: only the person added');

select pg_temp.act_as(:max);
select public.set_project_members((select id from made), array[:lucas::uuid]);
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v2),
  array[0, 3, 1], 'projects: the person removed and the person added');

update public.users set timezone = timezone where id = :lucas;
update public.users set timezone = 'Europe/Berlin' where id = :erin;
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v2),
  array[0, 4, 1], 'time zone: only when it changes, and only that person');

-- Saving a project or a client moves only the members who see it (#198) ------------------------------
-- 'Mobile app' now has Lucas only; Northwind's Website revamp has Erin and Lucas.

select pg_temp.act_as_postgres();
create temp table v3 as select pg_temp.org_v() as org, pg_temp.user_v(:erin) as erin, pg_temp.user_v(:lucas) as lucas;
grant select on v3 to authenticated;

select pg_temp.act_as(:max);
select public.save_project((select id from made), 'Mobile app v2');
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v3),
  array[0, 0, 1], 'project rename: its members only');

select pg_temp.act_as(:max);
select public.save_project((select id from made), 'Mobile app v2');
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v3),
  array[0, 0, 1], 'saving it again with nothing changed moves nobody');

select pg_temp.act_as(:max);
select public.save_project((select id from made), 'Mobile app v2', null, true, true);
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v3),
  array[0, 0, 2], 'project archive: its members only');

select pg_temp.act_as(:max);
select public.save_project((select id from made), 'Mobile app v2', '00000000-0000-4000-8000-0000000000e1', false, true);
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v3),
  array[0, 0, 3], 'project client or billable change: its members only');

-- Creating a project has no members to bump.
select pg_temp.act_as(:max);
select public.save_project(null, 'Brand new');
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v3),
  array[0, 0, 3], 'a new project moves nobody');

-- A client with one project that only Erin is on, and Northwind (Erin and Lucas).
select pg_temp.act_as(:max);
create temp table globex as select public.save_client(null, 'Globex') as id;
grant select on globex to authenticated;
create temp table portal as select public.save_project(null, 'Portal', (select id from globex)) as id;
grant select on portal to authenticated;
select public.set_project_members((select id from portal), array[:erin::uuid]);
select pg_temp.act_as_postgres();
create temp table v4 as select pg_temp.org_v() as org, pg_temp.user_v(:erin) as erin, pg_temp.user_v(:lucas) as lucas;
grant select on v4 to authenticated;

select pg_temp.act_as(:max);
select public.save_client((select id from globex), 'Globex Inc');
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v4),
  array[0, 1, 0], 'client rename: members of its projects only');

select pg_temp.act_as(:max);
select public.save_client((select id from globex), 'Globex Inc', true);
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v4),
  array[0, 1, 0], 'archiving a client alone changes no one''s config');

select pg_temp.act_as(:max);
select public.save_client('00000000-0000-4000-8000-0000000000e1', 'Northwind Traders');
select pg_temp.act_as_postgres();
select is(
  (select array[pg_temp.org_v() - org, pg_temp.user_v(:erin) - erin, pg_temp.user_v(:lucas) - lucas] from v4),
  array[0, 2, 1], 'another client rename: the members of that client''s projects');

select * from finish();
rollback;
