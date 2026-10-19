begin;
create extension if not exists pgtap with schema extensions;

select plan(9);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set newbie '''00000000-0000-4000-8000-0000000000e9'''

insert into auth.users (id, email) values (:newbie, 'founder@newco.test');

create function pg_temp.act_as(uid uuid, aal text default 'aal1') returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    ((internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims') || jsonb_build_object('aal', aal))::text, true);
  select set_config('role', 'authenticated', true);
$$;

select pg_temp.act_as(:newbie);
select throws_ok($$ select public.create_org('  ') $$, '22023', 'invalid_org_name', 'an org needs a name');
select throws_ok($$ select public.create_org('NewCo', 'us', null, 'Mars/Olympus') $$, '22023', 'invalid_timezone',
  'the time zone must be a real IANA zone');
select isnt(public.create_org('NewCo', 'us', 'Nia Founder', 'America/New_York'), null, 'a new user creates their org');
select throws_ok($$ select public.create_org('Again') $$, '42501', 'already_in_an_org', 'only once');

select set_config('role', 'postgres', true);
select is((select role::text from public.users where id = :newbie), 'owner', 'the founder is the owner');
select is((select o.data_region::text from public.orgs o join public.users u on u.org_id = o.id where u.id = :newbie),
  'us', 'pilots only use the US data region');

-- Admin MFA ---------------------------------------------------------------------
update public.orgs set policy = policy || '{"require_admin_mfa": true}' where id = '00000000-0000-4000-8000-000000000001';

select pg_temp.act_as(:ada, 'aal1');
select ok(not public.can_view_user(:erin), 'without MFA an owner loses the org-wide view when the org requires it');
select ok(public.can_view_user(:ada), 'but still sees their own data');
select pg_temp.act_as(:ada, 'aal2');
select ok(public.can_view_user(:erin), 'with an MFA-verified session the view is back');

select * from finish();
rollback;
