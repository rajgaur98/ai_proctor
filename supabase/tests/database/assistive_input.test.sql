-- #168: the assistive-input exemption (ANT-02, NFR-UX-02). Admins set it through
-- update_member; it is audit-logged, refetches the person's config and reaches the agent;
-- injected-click flags note it.
begin;
create extension if not exists pgtap with schema extensions;

select plan(21);

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

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

create function pg_temp.flag(uid uuid) returns boolean language sql as $$
  select assistive_input from public.users where id = uid $$;
create function pg_temp.user_v(uid uuid) returns int language sql as $$
  select config_version from public.users where id = uid $$;
create function pg_temp.audits(uid uuid) returns int language sql as $$
  select count(*)::int from public.audit_log
  where action = 'member.assistive_input_changed' and target_user_id = uid $$;

-- Erin's own fields, as the People page sends them back with the new value.
create function pg_temp.set_erin(v boolean) returns void language sql as $$
  select public.update_member(u.id, u.full_name, u.role, u.manager_id, u.work_country,
    u.work_state, u.timezone, v)
  from public.users u where u.id = '00000000-0000-4000-8000-0000000000c1'
$$;
grant execute on function pg_temp.set_erin(boolean) to authenticated;

select pg_temp.act_as(:erin);
create temp table dev_erin as select device_id from public.register_device('windows', '11', '0.1.0', 'hash-erin-assistive');
grant select on dev_erin to authenticated;
create function pg_temp.config() returns jsonb language sql as $$
  select public.agent_config((select device_id from dev_erin)) $$;
grant execute on function pg_temp.config() to authenticated;

-- Off by default -------------------------------------------------------------------------------

select pg_temp.act_as_postgres();
select is(pg_temp.flag(:erin), false, 'nobody uses assistive input until an admin says so');
select pg_temp.act_as(:erin);
select is(pg_temp.config() -> 'assistive_input', 'false'::jsonb, 'the agent''s config says off');

-- Only admins set it ---------------------------------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok($$ select pg_temp.set_erin(true) $$, '42501', 'admin_only',
  'her manager can''t');
select pg_temp.act_as(:erin);
select throws_ok($$ select pg_temp.set_erin(true) $$, '42501', 'admin_only',
  'she can''t set it herself through the RPC');
update public.users set assistive_input = true where id = :erin;
select pg_temp.act_as_postgres();
select is(pg_temp.flag(:erin), false, 'nor by writing her row (no update policy)');
select is(pg_temp.audits(:erin), 0, 'nothing was logged');

create temp table v0 as select pg_temp.user_v(:erin) as v;
grant select on v0 to authenticated;

select pg_temp.act_as(:ada);
select lives_ok($$ select pg_temp.set_erin(true) $$, 'an admin turns it on');
select pg_temp.act_as_postgres();
select is(pg_temp.flag(:erin), true, 'it is on');
select is(pg_temp.user_v(:erin), (select v from v0) + 1, 'her config_version moved, so her devices refetch');
select results_eq(
  $$ select actor_id, metadata from public.audit_log
     where action = 'member.assistive_input_changed' and target_user_id = '00000000-0000-4000-8000-0000000000c1' $$,
  $$ values ('00000000-0000-4000-8000-0000000000a1'::uuid, '{"from": false, "to": true}'::jsonb) $$,
  'audit-logged with who, whom, from and to');
select pg_temp.act_as(:erin);
select is(pg_temp.config() -> 'assistive_input', 'true'::jsonb, 'the agent''s config says on');
select is((pg_temp.config() ->> 'config_version')::int,
  (select o.policy_version + (select v from v0) + 1 from public.orgs o
   where o.id = '00000000-0000-4000-8000-000000000001'),
  'with the moved version');

-- Saving the same value, or leaving it out, changes nothing ---------------------------------------

select pg_temp.act_as(:ada);
select lives_ok($$ select pg_temp.set_erin(true) $$, 'saving it on again');
select lives_ok(
  $$ select public.update_member(u.id, u.full_name, u.role, u.manager_id, u.work_country,
       u.work_state, u.timezone)
     from public.users u where u.id = '00000000-0000-4000-8000-0000000000c1' $$,
  'an older caller without the argument');
select pg_temp.act_as_postgres();
select is(pg_temp.flag(:erin), true, 'leaves it on');
select is(pg_temp.audits(:erin), 1, 'and logs nothing more');
select is(pg_temp.user_v(:erin), (select v from v0) + 1, 'and doesn''t move her version');

-- Injected-click flags note it (the day page says "accepted") -----------------------------------

delete from public.anticheat_flags;
create function pg_temp.ci(who uuid, at timestamptz, fl text[]) returns void
language sql as $$
  insert into public.checkin_events (
    id, org_id, user_id, device_id, scheduled_at, shown_at, responded_at, outcome, response_ms, flags
  )
  values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', who,
          (select d.id from public.devices d where d.user_id = who limit 1),
          at, at, at + interval '4 seconds', 'pass', 4000, fl)
$$;
create function pg_temp.details(who uuid, k public.anticheat_kind) returns jsonb language sql as $$
  select details from public.anticheat_flags where user_id = who and kind = k $$;

select pg_temp.ci(:erin, timestamptz '2026-03-10 18:00:00+00', '{injected_click:2}');
select is(pg_temp.details(:erin, 'injected_click') -> 'assistive_input', 'true'::jsonb,
  'her injected clicks were accepted');
select is((pg_temp.details(:erin, 'injected_click') ->> 'clicks')::int, 2, 'still counted and flagged');

insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000d9', '00000000-0000-4000-8000-000000000001', :lucas,
        'windows', '11', '0.1.0', 'hash-lucas-assistive');
select pg_temp.ci(:lucas, timestamptz '2026-03-10 18:00:00+00', '{injected_click:1}');
select is(pg_temp.details(:lucas, 'injected_click') -> 'assistive_input', 'false'::jsonb,
  'without the exemption they were blocked');

select pg_temp.act_as(:ada);
select pg_temp.set_erin(false);
select pg_temp.act_as_postgres();
select results_eq(
  $$ select metadata from public.audit_log
     where action = 'member.assistive_input_changed' and target_user_id = '00000000-0000-4000-8000-0000000000c1'
     order by id desc limit 1 $$,
  $$ values ('{"from": true, "to": false}'::jsonb) $$,
  'turning it off is logged too');

select * from finish();
rollback;
