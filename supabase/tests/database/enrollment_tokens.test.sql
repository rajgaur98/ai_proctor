-- #86 (AGT-01): org enrollment tokens for MDM installs.
begin;
create extension if not exists pgtap with schema extensions;

select plan(43);

\set org '''00000000-0000-4000-8000-000000000001'''
\set org2 '''00000000-0000-4000-8000-000000000002'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set olga '''00000000-0000-4000-8000-0000000000a9'''
\set oscar '''00000000-0000-4000-8000-0000000000c9'''
-- The seeded test token (supabase/seed.sql).
\set seeded '''apet_local-test-token-for-acme-remote-not-secret'''

insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into auth.users (id, email) values (:olga, 'olga@other.test'), (:oscar, 'oscar@other.test');
insert into public.users (id, org_id, full_name, email, role, manager_id) values
  (:olga, :org2, 'Olga Owner', 'olga@other.test', 'owner', null),
  (:oscar, :org2, 'Oscar Employee', 'oscar@other.test', 'employee', :olga);

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

-- Tokens made in this test, by name, so later statements can use them.
create temp table made (name text primary key, id uuid, token text) on commit drop;
grant all on made to authenticated;

-- Creating ---------------------------------------------------------------------------

select pg_temp.act_as(:ada);
insert into made select 'jamf', id, token from public.create_enrollment_token('  Jamf: engineering Macs  ');
insert into made select 'intune', id, token from public.create_enrollment_token('Intune: laptops');

select matches((select token from made where name = 'jamf'), '^apet_[A-Za-z0-9_-]{43}$',
  'the token is apet_ and 43 base64url characters');
select isnt((select token from made where name = 'jamf'), (select token from made where name = 'intune'),
  'every token is new');
select results_eq(
  $$ select label, token_prefix, devices from public.list_enrollment_tokens() where id = (select id from made where name = 'jamf') $$,
  $$ values ('Jamf: engineering Macs'::text, (select left(token, 9) from made where name = 'jamf'), 0) $$,
  'the list shows the trimmed label, the prefix and no devices yet'
);
select ok(
  not exists (
    select 1 from public.list_enrollment_tokens() l, made m
    where m.name = 'jamf' and to_jsonb(l)::text like '%' || m.token || '%'
  ),
  'the list never returns the token itself'
);
select throws_ok($$ select * from public.create_enrollment_token('   ') $$,
  '22023', 'invalid_label', 'a label is required');
select throws_ok($$ select * from public.create_enrollment_token(repeat('x', 81)) $$,
  '22023', 'invalid_label', 'a label is at most 80 characters');

select pg_temp.act_as_postgres();
select is(
  (select t.token_hash from public.enrollment_tokens t join made m on m.id = t.id where m.name = 'jamf'),
  (select extensions.digest(convert_to(token, 'UTF8'), 'sha256') from made where name = 'jamf'),
  'only the SHA-256 of the token is stored'
);
select ok(
  not exists (
    select 1 from public.enrollment_tokens t, made m
    where to_jsonb(t)::text like '%' || substr(m.token, 10) || '%'
  ),
  'no column holds the token (beyond its prefix)'
);
select results_eq(
  $$ select action, actor_id, metadata ->> 'label' from public.audit_log
     where action = 'enrollment_token.created' and (metadata ->> 'token_id')::uuid = (select id from made where name = 'jamf') $$,
  $$ values ('enrollment_token.created'::text, '00000000-0000-4000-8000-0000000000a1'::uuid, 'Jamf: engineering Macs'::text) $$,
  'creating is audit-logged, with who and which token'
);
select ok(
  not exists (select 1 from public.audit_log l, made m where l.metadata::text like '%' || substr(m.token, 10) || '%'),
  'the audit log never holds the token'
);

-- Only owners and admins of the org ----------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok($$ select * from public.create_enrollment_token('x') $$,
  '42501', 'admin_only', 'a manager cannot create a token');
select throws_ok($$ select * from public.list_enrollment_tokens() $$,
  '42501', 'admin_only', 'or list them');
select throws_ok(
  format('select public.revoke_enrollment_token(%L)', (select id from made where name = 'jamf')),
  '42501', 'admin_only', 'or revoke one'
);
select pg_temp.act_as(:erin);
select throws_ok($$ select * from public.list_enrollment_tokens() $$,
  '42501', 'admin_only', 'an employee cannot list them');
select throws_ok($$ select * from public.enrollment_tokens $$,
  '42501', null, 'nobody reads the table through the API');

set local role anon;
select throws_ok($$ select * from public.list_enrollment_tokens() $$,
  '42501', null, 'anon cannot call the admin RPCs');
select throws_ok($$ select * from public.register_device('macos', '26.0', '0.1.0', 'hash-anon-token', 'apet_local-test-token-for-acme-remote-not-secret') $$,
  '42501', null, 'and no RPC takes a token before sign-in');
reset role;

select pg_temp.act_as(:olga);
select is((select count(*)::int from public.list_enrollment_tokens()), 0,
  'another org''s owner sees none of Acme''s tokens');
select throws_ok(
  format('select public.revoke_enrollment_token(%L)', (select id from made where name = 'jamf')),
  '42501', 'token_not_found', 'and cannot revoke them'
);

-- MFA, when the org asks for it for admins ----------------------------------------------

select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"require_admin_mfa": true}' where id = :org;
select pg_temp.act_as(:ada);
select throws_ok($$ select * from public.create_enrollment_token('x') $$,
  '42501', 'mfa_required', 'an org that requires MFA creates tokens with a verified session only');
select pg_temp.act_as_postgres();
update public.orgs set policy = policy - 'require_admin_mfa' where id = :org;

-- Enrolling at sign-in (register_device) ------------------------------------------------

select pg_temp.act_as(:erin);
select isnt(
  (select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-mdm',
     (select token from made where name = 'jamf'))),
  null, 'an employee enrolls with her org''s token'
);
select pg_temp.act_as_postgres();
select is(
  (select enrollment_token_id from public.devices where hardware_hash = 'hash-erin-mdm'),
  (select id from made where name = 'jamf'), 'the device is linked to the token'
);
select results_eq(
  $$ select actor_id, target_user_id, metadata ->> 'device_id' from public.audit_log
     where action = 'enrollment_token.used' and (metadata ->> 'token_id')::uuid = (select id from made where name = 'jamf') $$,
  $$ select '00000000-0000-4000-8000-0000000000c1'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid, id::text
     from public.devices where hardware_hash = 'hash-erin-mdm' $$,
  'the enrollment is audit-logged with the person and the device'
);
select isnt((select last_used_at from public.enrollment_tokens t join made m on m.id = t.id where m.name = 'jamf'),
  null, 'and the token shows when it was last used');

select pg_temp.act_as(:erin);
select lives_ok(
  format($$ select * from public.register_device('macos', '26.1', '0.1.1', 'hash-erin-mdm', %L) $$,
    (select token from made where name = 'jamf')),
  'signing in again on the same computer works'
);
select pg_temp.act_as_postgres();
select is(
  (select count(*)::int from public.audit_log where action = 'enrollment_token.used'
     and (metadata ->> 'token_id')::uuid = (select id from made where name = 'jamf')),
  1, 'and is not a second enrollment'
);

select pg_temp.act_as(:lucas);
select lives_ok(
  $$ select * from public.register_device('macos', '26.0', '0.1.0', 'hash-lucas-seeded', 'apet_local-test-token-for-acme-remote-not-secret') $$,
  'the seeded test token enrolls too'
);
select lives_ok(
  $$ select * from public.register_device('macos', '26.0', '0.1.0', 'hash-lucas-manual') $$,
  'a manual install (no token) still registers'
);
select lives_ok(
  format($$ select * from public.register_device('macos', '26.0', '0.1.0', 'hash-lucas-manual', %L) $$,
    (select token from made where name = 'intune')),
  'and MDM can take it over later'
);
select pg_temp.act_as_postgres();
select is(
  (select enrollment_token_id from public.devices where hardware_hash = 'hash-lucas-manual'),
  (select id from made where name = 'intune'), 'which links the device to that token'
);

select pg_temp.act_as(:ada);
select is(
  (select devices from public.list_enrollment_tokens() where id = (select id from made where name = 'jamf')),
  1, 'the list counts the devices a token enrolled'
);

-- Refusals ----------------------------------------------------------------------------

select pg_temp.act_as(:oscar);
select throws_ok(
  format($$ select * from public.register_device('macos', '26.0', '0.1.0', 'hash-oscar-acme', %L) $$,
    (select token from made where name = 'jamf')),
  '42501', 'enrollment_org_mismatch', 'someone from another org cannot sign in on an Acme-managed computer'
);
select pg_temp.act_as_postgres();
select is(
  (select org_id from public.users where id = :oscar), :org2::uuid,
  'and the token never moves them into Acme'
);
select is((select count(*)::int from public.devices where user_id = :oscar), 0, 'no device was made for them');

select pg_temp.act_as(:erin);
select throws_ok(
  $$ select * from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-typo', 'apet_not-a-real-token-but-shaped-like-one-000') $$,
  '42501', 'enrollment_token_invalid', 'an unknown token is refused'
);
select throws_ok(
  $$ select * from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-typo', 'hello') $$,
  '42501', 'enrollment_token_invalid', 'and so is something that is not a token'
);

-- Revoking ------------------------------------------------------------------------------

select pg_temp.act_as(:ada);
select lives_ok(
  format('select public.revoke_enrollment_token(%L)', (select id from made where name = 'jamf')),
  'an admin revokes a token'
);
select lives_ok(
  format('select public.revoke_enrollment_token(%L)', (select id from made where name = 'jamf')),
  'revoking it again changes nothing'
);
select pg_temp.act_as_postgres();
select is(
  (select count(*)::int from public.audit_log where action = 'enrollment_token.revoked'
     and actor_id = :ada and (metadata ->> 'token_id')::uuid = (select id from made where name = 'jamf')),
  1, 'revoking is audit-logged once'
);

select pg_temp.act_as(:lucas);
select throws_ok(
  format($$ select * from public.register_device('macos', '26.0', '0.1.0', 'hash-lucas-new-mac', %L) $$,
    (select token from made where name = 'jamf')),
  '42501', 'enrollment_token_revoked', 'a revoked token enrolls no new device'
);
select pg_temp.act_as(:erin);
select lives_ok(
  format($$ select * from public.register_device('macos', '26.1', '0.1.2', 'hash-erin-mdm', %L) $$,
    (select token from made where name = 'jamf')),
  'a device it already enrolled keeps signing in'
);
select pg_temp.act_as_postgres();
select ok(
  (select revoked_at is null and enrollment_token_id = (select id from made where name = 'jamf')
   from public.devices where hardware_hash = 'hash-erin-mdm'),
  'and stays registered and linked'
);
select pg_temp.act_as(:oscar);
select throws_ok(
  format($$ select * from public.register_device('macos', '26.0', '0.1.0', 'hash-oscar-acme', %L) $$,
    (select token from made where name = 'jamf')),
  '42501', 'enrollment_org_mismatch', 'a revoked token is still Acme''s: another org gets the mismatch'
);

select * from finish();
rollback;
