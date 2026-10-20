begin;
create extension if not exists pgtap with schema extensions;

select plan(24);

-- Org 1 (seed): Ada owner → Max manager → Erin, Lucas employees.
-- Added here: Ann (admin), Mia (manager under Max) → Zoe (employee under Mia),
-- and org 2 with Olga (owner) → Oscar (employee).
\set org1 '''00000000-0000-4000-8000-000000000001'''
\set org2 '''00000000-0000-4000-8000-000000000002'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set ann '''00000000-0000-4000-8000-0000000000a2'''
\set mia '''00000000-0000-4000-8000-0000000000b2'''
\set zoe '''00000000-0000-4000-8000-0000000000c3'''
\set olga '''00000000-0000-4000-8000-0000000000a9'''
\set oscar '''00000000-0000-4000-8000-0000000000c9'''

insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into auth.users (id, email) values
  (:ann, 'ann@acme.test'), (:mia, 'mia@acme.test'), (:zoe, 'zoe@acme.test'),
  (:olga, 'olga@other.test'), (:oscar, 'oscar@other.test');
insert into public.users (id, org_id, full_name, email, role, manager_id) values
  (:ann, :org1, 'Ann Admin', 'ann@acme.test', 'admin', :ada),
  (:mia, :org1, 'Mia Manager', 'mia@acme.test', 'manager', :max),
  (:zoe, :org1, 'Zoe Employee', 'zoe@acme.test', 'employee', :mia),
  (:olga, :org2, 'Olga Owner', 'olga@other.test', 'owner', null),
  (:oscar, :org2, 'Oscar Employee', 'oscar@other.test', 'employee', :olga);
insert into public.presence (user_id, org_id)
select id, org_id from public.users on conflict (user_id) do nothing;

-- Acts as a user with the claims the access-token hook would mint.
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

create function pg_temp.visible_users() returns text[]
language sql as $$
  select array_agg(full_name order by full_name) from public.users;
$$;

-- Hook ---------------------------------------------------------------------------

select is(
  internal.custom_access_token_hook(jsonb_build_object('user_id', :erin, 'claims', '{}'::jsonb)) -> 'claims' ->> 'org_id',
  '00000000-0000-4000-8000-000000000001', 'the access token carries org_id'
);
select is(
  internal.custom_access_token_hook(jsonb_build_object('user_id', :ann, 'claims', '{}'::jsonb)) -> 'claims' ->> 'app_role',
  'admin', 'and the app role'
);

-- Who sees whom --------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is(pg_temp.visible_users(), array['Erin Employee'], 'an employee sees only themselves');

select pg_temp.act_as(:max);
select is(pg_temp.visible_users(), array['Erin Employee', 'Lucas Martin', 'Max Manager', 'Mia Manager'],
  'a manager sees themselves and direct reports');
select ok(not public.can_view_user(:zoe), 'no skip-level: Max cannot see Mia''s report Zoe');

select pg_temp.act_as(:mia);
select ok(not public.can_view_user(:erin), 'a peer manager cannot see another manager''s reports');
select is(pg_temp.visible_users(), array['Mia Manager', 'Zoe Employee'], 'Mia sees only her own team');

select pg_temp.act_as(:ann);
select is(array_length(pg_temp.visible_users(), 1), 7, 'an admin sees everyone in the org');
select ok(not public.can_view_user(:oscar), 'but not other orgs');

select pg_temp.act_as(:olga);
select is(pg_temp.visible_users(), array['Olga Owner', 'Oscar Employee'], 'the other org''s owner sees only their org');
select is_empty('select 1 from public.orgs where id = ''00000000-0000-4000-8000-000000000001''', 'and cannot read our org row');

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.presence), 1, 'presence follows the same rule');

-- Delegation -------------------------------------------------------------------------

select pg_temp.act_as_postgres();
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org1, :max, :mia, current_date - 1, current_date + 6);

select pg_temp.act_as(:mia);
select ok(public.can_view_user(:erin), 'an active delegate sees the manager''s reports');
select ok(public.can_approve_for(:erin), 'and can approve them');

select pg_temp.act_as_postgres();
update public.delegations set starts_on = current_date - 20, ends_on = current_date - 10;
select pg_temp.act_as(:mia);
select ok(not public.can_view_user(:erin), 'an expired delegation grants nothing');

-- Approval (TS-12) ---------------------------------------------------------------------

select pg_temp.act_as(:max);
select ok(public.can_approve_for(:erin), 'the direct manager can approve');
select ok(not public.can_approve_for(:max), 'nobody approves their own timesheet');

select pg_temp.act_as(:ann);
select ok(public.can_view_user(:erin), 'an admin can view');
select ok(not public.can_approve_for(:erin), 'but admins never approve');

select pg_temp.act_as(:ada);
select ok(not public.can_approve_for(:max), 'the owner never approves, even as direct manager');

-- Writes and stale tokens --------------------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok(
  format('insert into public.devices (org_id, user_id, platform, os_version, agent_version, hardware_hash)
          values (%L, %L, %L, %L, %L, %L)', :org1, :erin, 'macos', '26', '0.1.0', 'hash-direct'),
  '42501', null, 'API roles cannot insert rows directly'
);

select pg_temp.act_as(:max);
update public.users set full_name = 'x' where id = :erin;
select pg_temp.act_as_postgres();
select is((select full_name from public.users where id = :erin), 'Erin Employee',
  'an update through the API changes nothing');

select pg_temp.act_as(:max);
select set_config('request.jwt.claims', jsonb_build_object('sub', :max, 'role', 'authenticated')::text, true);
select is(pg_temp.visible_users(), null, 'a token without org_id sees nothing');

select pg_temp.act_as_postgres();
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
       and c.relname not in ('device_sessions', 'agent_event_rejections', 'email_outbox', 'dirty_days')
       and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) $$,
  'every public table except the internal ones (no API access at all) has a read policy'
);

select * from finish();
rollback;
