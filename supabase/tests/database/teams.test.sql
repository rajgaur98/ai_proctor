-- #66: teams and per-team policy overrides (ORG-08, ADM-02), and the team filter in
-- reports and exports (#202).
begin;
create extension if not exists pgtap with schema extensions;

select plan(67);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set org2 '''00000000-0000-4000-8000-000000000002'''
\set olga '''00000000-0000-4000-8000-0000000000e1'''

create function pg_temp.act_as(uid uuid, aal text default 'aal1') returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    ((internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims') || jsonb_build_object('aal', aal))::text, true);
  select set_config('role', 'authenticated', true);
$$;

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

create function pg_temp.user_v(uid uuid) returns int language sql as $$
  select config_version from public.users where id = uid $$;
create function pg_temp.team_of(uid uuid) returns uuid language sql as $$
  select team_id from public.users where id = uid $$;
create function pg_temp.audits(p_action text) returns int language sql as $$
  select count(*)::int from public.audit_log where action = p_action $$;

-- Another org, to show a team is its org's alone.
insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into auth.users (id, email) values (:olga, 'olga@other.test');
insert into public.users (id, org_id, full_name, email, role, manager_id)
values (:olga, :org2, 'Olga Owner', 'olga@other.test', 'owner', null);

-- Devices for the two employees, so their agent config and heartbeat can be read.
select pg_temp.act_as(:erin);
create temp table dev_erin as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-teams');
grant select on dev_erin to authenticated;
select pg_temp.act_as(:lucas);
create temp table dev_lucas as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-lucas-teams');
grant select on dev_lucas to authenticated;

create function pg_temp.config(dev uuid) returns jsonb language sql as $$
  select public.agent_config(dev) -> 'policy' $$;
grant execute on function pg_temp.config(uuid) to authenticated;

-- Creating and naming (ORG-08) ---------------------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok($$ select public.save_team(null, 'Support') $$, '42501', 'admin_only',
  'a manager cannot create a team');

select pg_temp.act_as(:ada);
create temp table t as select public.save_team(null, '  Support  ') as support;
grant select on t to authenticated;
select is((select name from public.teams where id = (select support from t)), 'Support',
  'an admin creates a team; the name is trimmed');
select throws_ok($$ select public.save_team(null, 'support') $$, '23505', 'name_taken',
  'names are unique in the org, ignoring case');
select throws_ok($$ select public.save_team(null, '   ') $$, '22023', 'invalid_name',
  'a team needs a name');
select throws_ok($$ select public.save_team(null, repeat('x', 81)) $$, '22023', 'invalid_name',
  'up to 80 characters');
alter table t add column eng uuid;
update t set eng = public.save_team(null, 'Engineering');
select lives_ok($$ select public.save_team((select eng from t), 'Engineering & Design') $$,
  'an admin renames a team');
select is((select name from public.teams where id = (select eng from t)), 'Engineering & Design',
  'the new name is stored');
select is(pg_temp.audits('team.created'), 2, 'each creation is audit-logged');
select is(
  (select metadata from public.audit_log where action = 'team.renamed'),
  jsonb_build_object('team_id', (select eng from t), 'from', 'Engineering', 'to', 'Engineering & Design'),
  'the rename is audit-logged with both names');

select pg_temp.act_as(:olga);
select throws_ok($$ select public.save_team((select support from t), 'Mine') $$, '42501', 'team_not_found',
  'another org''s owner cannot rename it');
select lives_ok($$ select public.save_team(null, 'Support') $$,
  'the same name is free in another org');

-- Members --------------------------------------------------------------------------------------

select pg_temp.act_as_postgres();
create temp table v0 as
  select pg_temp.user_v(:erin) as erin, pg_temp.user_v(:lucas) as lucas, pg_temp.user_v(:max) as max;
grant select on v0 to authenticated;

select pg_temp.act_as(:max);
select throws_ok($$ select public.set_team_members((select support from t), array['00000000-0000-4000-8000-0000000000c1']::uuid[]) $$,
  '42501', 'admin_only', 'a manager cannot change who is in a team');

select pg_temp.act_as(:ada);
select throws_ok($$ select public.set_team_members((select support from t), array['00000000-0000-4000-8000-0000000000e1']::uuid[]) $$,
  '42501', 'user_not_found', 'someone from another org cannot join');
select lives_ok($$ select public.set_team_members((select support from t), array['00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c2']::uuid[]) $$,
  'an admin puts Erin and Lucas in Support');
select is(pg_temp.team_of(:erin), (select support from t), 'Erin is in Support');
select is(pg_temp.team_of(:lucas), (select support from t), 'so is Lucas');
select is(pg_temp.user_v(:erin), (select erin from v0) + 1, 'moving Erin bumps her config version');
select is(pg_temp.user_v(:max), (select max from v0), 'and nobody else''s');
select is(pg_temp.audits('member.team_changed'), 2, 'each move is audit-logged');
select is(
  (select metadata from public.audit_log where action = 'member.team_changed' and target_user_id = :erin),
  jsonb_build_object('from', null, 'from_name', null, 'to', (select support from t), 'to_name', 'Support'),
  'with the team she left and the one she joined');

-- One team per person: joining Engineering takes Lucas out of Support.
select lives_ok($$ select public.set_team_members((select eng from t), array['00000000-0000-4000-8000-0000000000c2']::uuid[]) $$,
  'Lucas moves to Engineering');
select is(pg_temp.team_of(:lucas), (select eng from t), 'he is in Engineering now');
select is(pg_temp.team_of(:erin), (select support from t), 'Erin stays in Support');
select lives_ok($$ select public.set_team_members((select eng from t), array['00000000-0000-4000-8000-0000000000c2']::uuid[]) $$,
  'setting the same members again');
select is(pg_temp.audits('member.team_changed'), 3, 'records nothing new');

-- Reading teams (RLS) -------------------------------------------------------------------------

select pg_temp.act_as(:ada);
select is((select count(*)::int from public.teams), 2, 'an admin reads every team of the org');
select pg_temp.act_as(:max);
select is((select string_agg(name, ', ' order by name) from public.teams), 'Engineering & Design, Support',
  'a manager reads the teams his reports are in');
select pg_temp.act_as(:erin);
select is((select string_agg(name, ', ' order by name) from public.teams), 'Support',
  'an employee reads only her own team');
select pg_temp.act_as(:olga);
select is((select string_agg(name, ', ' order by name) from public.teams), 'Support',
  'another org sees only its own');
select pg_temp.act_as(:max);
select is((select team_id from public.team_live where user_id = :erin), (select support from t),
  'the live grid row carries the team');

-- Overrides (ADM-02) ---------------------------------------------------------------------------

select pg_temp.act_as_postgres();
create temp table v1 as
  select pg_temp.user_v(:erin) as erin, pg_temp.user_v(:lucas) as lucas;
grant select on v1 to authenticated;

select pg_temp.act_as(:max);
select throws_ok($$ select public.set_team_policy((select support from t), '{"checkin_response_s": 60}') $$,
  '42501', 'admin_only', 'a manager cannot override policy');

select pg_temp.act_as(:ada);
select throws_ok($$ select public.set_team_policy((select support from t), '{"screenshots": "off"}') $$,
  '22023', 'not_team_policy_key', 'what is collected stays org-wide');
select throws_ok($$ select public.set_team_policy((select support from t), '{"bogus": 1}') $$,
  '22023', 'unknown_policy_key', 'an unknown key is refused');
select throws_ok($$ select public.set_team_policy((select support from t), '{"checkin_response_s": 10}') $$,
  '22023', 'invalid_policy', 'the org policy''s ranges apply');
select throws_ok($$ select public.set_team_policy((select support from t), '{"auto_clock_in": "yes"}') $$,
  '22023', 'invalid_policy', 'and its types');
select throws_ok($$ select public.set_team_policy((select support from t), '{"checkin_min_interval_min": 15}') $$,
  '22023', 'invalid_policy', 'the interval is overridden as a pair');
select throws_ok($$ select public.set_team_policy((select support from t),
  '{"checkin_min_interval_min": 40, "checkin_max_interval_min": 30}') $$,
  '22023', 'invalid_policy', 'whose shortest is at most its longest');
select is(
  public.set_team_policy((select support from t),
    '{"checkin_min_interval_min": 15, "checkin_max_interval_min": 30.0, "idle_threshold_min": 3}'),
  '{"changed": ["checkin_max_interval_min", "checkin_min_interval_min", "idle_threshold_min"]}'::jsonb,
  'an admin overrides Support''s interval and idle threshold');
select is((select policy from public.teams where id = (select support from t)),
  '{"checkin_min_interval_min": 15, "checkin_max_interval_min": 30, "idle_threshold_min": 3}'::jsonb,
  'stored normalised');
select is(pg_temp.user_v(:erin), (select erin from v1) + 1, 'the change bumps her config version');
select is(pg_temp.user_v(:lucas), (select lucas from v1), 'not Lucas''s: he is in another team');
select is(
  (select metadata -> 'changed' -> 'checkin_min_interval_min' from public.audit_log
   where action = 'team.policy_changed'),
  '{"from": null, "to": 15}'::jsonb,
  'audit-logged per key, null meaning the org''s value');
select is(
  public.set_team_policy((select support from t),
    '{"checkin_min_interval_min": 15, "checkin_max_interval_min": 30, "idle_threshold_min": 3}'),
  '{"changed": []}'::jsonb, 'saving the same overrides changes nothing');
select is(pg_temp.audits('team.policy_changed'), 1, 'and logs nothing');

-- Precedence: org policy, then the team's overrides ----------------------------------------

select lives_ok($$ select public.update_policy('{"checkin_min_interval_min": 25, "checkin_response_s": 120}') $$,
  'the org changes its interval and response window');
select pg_temp.act_as(:erin);
select is((pg_temp.config((select device_id from dev_erin)) ->> 'checkin_min_interval_min')::int, 15,
  'Erin''s agent runs with her team''s interval');
select is((pg_temp.config((select device_id from dev_erin)) ->> 'checkin_response_s')::int, 120,
  'and the org''s response window, which her team does not override');
select pg_temp.act_as(:lucas);
select is((pg_temp.config((select device_id from dev_lucas)) ->> 'checkin_min_interval_min')::int, 25,
  'Lucas''s team overrides nothing, so he runs with the org''s');
select pg_temp.act_as_postgres();
select is((internal.effective_policy(:erin) ->> 'checkin_max_interval_min')::int, 30,
  'effective_policy: the team wins over the org');
select is((internal.effective_policy(:lucas) ->> 'idle_threshold_min')::int, 10,
  'and a key nobody set is the default');

-- Idle follows the person's threshold: 200 s is idle at 3 min, not at the org's 10.
select pg_temp.act_as(:erin);
select lives_ok($$ select public.agent_heartbeat((select device_id from dev_erin), now(), 200, false, false, '0.1.1', '{}') $$,
  'Erin''s agent reports 200 s without input');
select pg_temp.act_as(:lucas);
select lives_ok($$ select public.agent_heartbeat((select device_id from dev_lucas), now(), 200, false, false, '0.1.1', '{}') $$,
  'so does Lucas''s');
select pg_temp.act_as_postgres();
select is((select idle from public.presence where user_id = :erin), true, 'Erin is idle by her team''s threshold');
select is((select idle from public.presence where user_id = :lucas), false, 'Lucas is not, by the org''s');

-- An org that requires admin MFA changes team policy with a verified session only.
select pg_temp.act_as(:ada, 'aal2');
select lives_ok($$ select public.update_policy('{"require_admin_mfa": true}') $$, 'the org requires admin MFA');
select pg_temp.act_as(:ada, 'aal1');
select throws_ok($$ select public.set_team_policy((select support from t), '{}') $$, '42501', 'mfa_required',
  'without a verified session the overrides cannot change');
select pg_temp.act_as(:ada, 'aal2');
select lives_ok($$ select public.update_policy('{"require_admin_mfa": false}') $$, 'back off');

-- Team filter in reports and exports (#202) ------------------------------------------------

select pg_temp.act_as_postgres();
insert into public.time_segments
  (org_id, user_id, day, start_at, end_at, type, project_id, counted, flagged, excluded)
values
  (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07', 'verified', null, true, false, false),
  (:org, :lucas, '2026-03-16', '2026-03-16 09:00:00-05', '2026-03-16 10:30:00-05', 'verified', null, true, false, false);

select pg_temp.act_as(:ada);
select is(
  (select string_agg(r ->> 'full_name', ', ' order by r ->> 'full_name')
   from jsonb_array_elements(public.report_rows('2026-03-16', '2026-03-16', null, null, (select support from t)) -> 'rows') r),
  'Erin Employee', 'report_rows: the team filter keeps its members');
select is(
  (select (r ->> 'team_id')::uuid
   from jsonb_array_elements(public.report_rows('2026-03-16', '2026-03-16', array[:lucas]::uuid[]) -> 'rows') r),
  (select eng from t), 'and each row carries the team');
select is(
  (select string_agg(distinct r ->> 'employee', ', ')
   from jsonb_array_elements(public.timesheet_export_rows('2026-03-16', '2026-03-16', 'segments',
     p_team_id => (select eng from t)) -> 'rows') r),
  'Lucas Martin', 'timesheet_export_rows: the team filter keeps its members');
select is(
  (select metadata ->> 'team_id' from public.audit_log where action = 'timesheet.exported'
   order by at desc limit 1)::uuid,
  (select eng from t), 'and the export''s audit row records it');

-- Deleting -------------------------------------------------------------------------------------

select pg_temp.act_as_postgres();
create temp table v2 as select pg_temp.user_v(:erin) as erin;
grant select on v2 to authenticated;
select pg_temp.act_as(:max);
select throws_ok($$ select public.delete_team((select support from t)) $$, '42501', 'admin_only',
  'a manager cannot delete a team');
select pg_temp.act_as(:ada);
select lives_ok($$ select public.delete_team((select support from t)) $$, 'an admin deletes Support');
select is(pg_temp.team_of(:erin), null, 'Erin is in no team now');
select is(pg_temp.user_v(:erin), (select erin from v2) + 1, 'and her agent refetches');
select pg_temp.act_as(:erin);
select is((pg_temp.config((select device_id from dev_erin)) ->> 'checkin_min_interval_min')::int, 25,
  'it runs with the org''s interval again');
select pg_temp.act_as_postgres();
select is(
  (select metadata -> 'members' from public.audit_log where action = 'team.deleted'),
  jsonb_build_array(:erin), 'the deletion is audit-logged with who was in it');

select * from finish();
rollback;
