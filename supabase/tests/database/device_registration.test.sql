begin;
create extension if not exists pgtap with schema extensions;

select plan(22);

-- Seed ids (supabase/seed.sql).
\set org '''00000000-0000-4000-8000-000000000001'''
\set owner '''00000000-0000-4000-8000-0000000000a1'''
\set manager '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set s1 '''11111111-1111-4111-8111-111111111111'''
\set s2 '''22222222-2222-4222-8222-222222222222'''

-- Two Auth sessions for Erin, as if she signed in on her Mac twice.
insert into auth.sessions (id, user_id, created_at, updated_at)
values (:s1, :erin, now(), now()), (:s2, :erin, now(), now());

-- Acts as a signed-in user with the given Auth session.
create function pg_temp.act_as(uid uuid, session uuid default null) returns void
language sql as $$
  select set_config('role', 'authenticated', true);
  select set_config(
    'request.jwt.claims',
    jsonb_strip_nulls(jsonb_build_object('sub', uid, 'role', 'authenticated', 'session_id', session))::text,
    true
  );
$$;

-- Same claims, but stays postgres: for calling internal.* helpers, which the API
-- roles cannot reach.
create function pg_temp.claims_as(uid uuid, session uuid default null) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config(
    'request.jwt.claims',
    jsonb_strip_nulls(jsonb_build_object('sub', uid, 'role', 'authenticated', 'session_id', session))::text,
    true
  );
$$;

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- register_device ------------------------------------------------------------

select pg_temp.act_as(:erin, :s1);
create temp table reg1 on commit drop as
  select * from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-mac');
grant select on reg1 to authenticated;

select isnt((select device_id from reg1), null, 'register_device returns a device id');
select is((select policy_version from reg1), 1, 'register_device returns the org policy version');

select is(
  (select device_id from public.register_device('macos', '26.1', '0.1.1', 'hash-erin-mac')),
  (select device_id from reg1),
  'registering the same hardware again returns the same device'
);

select throws_ok(
  $$ select * from public.register_device('macos', '26.0', '0.1.0', 'short') $$,
  '22023', 'invalid_device_info', 'rejects a too-short hardware hash'
);

select pg_temp.act_as_postgres();

select is(
  (select count(*)::int from public.devices where user_id = :erin),
  1, 'only one device row for Erin'
);
select is(
  (select agent_version from public.devices where id = (select device_id from reg1)),
  '0.1.1', 'a repeat registration updates the agent version'
);
select is(
  (select device_id from public.device_sessions where session_id = :s1),
  (select device_id from reg1), 'the Auth session is bound to the device'
);

-- Access-token hook ----------------------------------------------------------

select is(
  internal.custom_access_token_hook(jsonb_build_object(
    'user_id', :erin, 'claims', jsonb_build_object('sub', :erin, 'session_id', :s1)
  )) -> 'claims' ->> 'device_id',
  (select device_id::text from reg1),
  'hook adds device_id for a registered session'
);
select ok(
  not (internal.custom_access_token_hook(jsonb_build_object(
    'user_id', :erin, 'claims', jsonb_build_object('sub', :erin, 'session_id', :s2)
  )) -> 'claims' ? 'device_id'),
  'hook adds no device_id for a session with no device'
);

-- Device checks --------------------------------------------------------------

select pg_temp.claims_as(:erin, :s1);
select is(
  (internal.require_active_device((select device_id from reg1))).id,
  (select device_id from reg1),
  'the owner of an active device passes the device check'
);

select pg_temp.claims_as(:lucas);
select throws_ok(
  format('select internal.require_active_device(%L)', (select device_id from reg1)),
  '42501', 'device_not_found', 'another user cannot use Erin''s device'
);

select pg_temp.act_as(:erin);
select throws_ok(
  format('select public.revoke_device(%L)', (select device_id from reg1)),
  '42501', 'admin_only', 'an employee cannot revoke devices'
);

-- revoke_device --------------------------------------------------------------

select pg_temp.act_as(:owner);
select lives_ok(
  format('select public.revoke_device(%L)', (select device_id from reg1)),
  'the org owner can revoke a device'
);

select pg_temp.act_as_postgres();
select isnt(
  (select revoked_at from public.devices where id = (select device_id from reg1)),
  null, 'revoked device has revoked_at'
);
select is_empty(
  format('select 1 from auth.sessions where id = %L', :s1),
  'revoking ends the device''s Auth session'
);

select pg_temp.claims_as(:erin);
select throws_ok(
  format('select internal.require_active_device(%L)', (select device_id from reg1)),
  '42501', 'device_revoked', 'a revoked device fails its next check'
);

-- set_user_active ------------------------------------------------------------

select pg_temp.act_as(:manager);
select throws_ok(
  format('select public.set_user_active(%L, false)', :erin),
  '42501', 'admin_only', 'a manager cannot deactivate users'
);

select pg_temp.act_as(:owner);
select throws_ok(
  format('select public.set_user_active(%L, false)', :owner),
  '42501', 'cannot_change_self', 'the owner cannot deactivate themselves'
);
select lives_ok(
  format('select public.set_user_active(%L, false)', :erin),
  'the owner can deactivate an employee'
);

select pg_temp.act_as_postgres();
select is_empty(
  format('select 1 from auth.sessions where user_id = %L', :erin),
  'deactivation ends all of the user''s sessions'
);
select is(
  internal.custom_access_token_hook(jsonb_build_object(
    'user_id', :erin, 'claims', jsonb_build_object('sub', :erin)
  )) -> 'error' ->> 'message',
  'user_inactive',
  'hook refuses tokens for a deactivated user'
);

select pg_temp.act_as(:erin);
select throws_ok(
  $$ select * from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-mac-2') $$,
  '42501', 'user_inactive', 'a deactivated user cannot register a device'
);

select pg_temp.act_as_postgres();
select * from finish();
rollback;
