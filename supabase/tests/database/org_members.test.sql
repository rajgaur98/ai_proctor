begin;
create extension if not exists pgtap with schema extensions;

select plan(23);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set newbie '''00000000-0000-4000-8000-0000000000d1'''

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

-- Ada (owner) moves Erin under herself and makes her a manager.
select pg_temp.act_as(:erin);
select throws_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000c2', 'Lucas Martin', 'employee',
       '00000000-0000-4000-8000-0000000000c1', 'US', 'TX', 'America/Chicago') $$,
  '42501', 'admin_only', 'an employee cannot change members'
);

select pg_temp.act_as(:ada);
select lives_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000c1', 'Erin Employee', 'manager',
       '00000000-0000-4000-8000-0000000000a1', 'US', 'CA', 'America/Los_Angeles') $$,
  'the owner changes Erin''s role and manager'
);
select results_eq(
  $$ select action, metadata from public.audit_log
     where target_user_id = '00000000-0000-4000-8000-0000000000c1' order by id $$,
  $$ values ('member.role_changed', '{"from": "employee", "to": "manager"}'::jsonb),
            ('member.manager_changed', jsonb_build_object(
               'from', '00000000-0000-4000-8000-0000000000b1', 'to', '00000000-0000-4000-8000-0000000000a1')) $$,
  'role and reporting-line changes are audit-logged with before and after (AUD-01)'
);
select is((select actor_id from public.audit_log order by id desc limit 1), :ada::uuid, 'with the actor');

select lives_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000c1', 'Erin Employee', 'manager',
       '00000000-0000-4000-8000-0000000000a1', 'IN', null, 'Asia/Kolkata') $$,
  'work location outside the US has no state'
);
select is((select action from public.audit_log order by id desc limit 1), 'member.location_changed',
  'location changes are logged too');

-- ORG-05/06 rules.
select throws_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000c2', 'Lucas Martin', 'employee',
       '00000000-0000-4000-8000-0000000000b1', 'US', null, 'America/Chicago') $$,
  '22023', 'us_state_required', 'US needs a state'
);
select throws_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000c2', 'Lucas Martin', 'employee',
       null, 'US', 'TX', 'America/Chicago') $$,
  '22023', 'manager_required', 'everyone but the owner has a direct manager'
);
select throws_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000b1', 'Max Manager', 'manager',
       '00000000-0000-4000-8000-0000000000c2', 'US', 'IL', 'America/Chicago') $$,
  '22023', 'manager_must_be_manager_or_admin', 'an employee cannot be someone''s manager'
);
select throws_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000b1', 'Max Manager', 'manager',
       '00000000-0000-4000-8000-0000000000b1', 'US', 'IL', 'America/Chicago') $$,
  '22023', 'cannot_manage_self', 'nobody manages themselves'
);
-- Lucas reports to Max; Max reporting to someone under him would be a loop.
select lives_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000c2', 'Lucas Martin', 'manager',
       '00000000-0000-4000-8000-0000000000b1', 'US', 'TX', 'America/Chicago') $$,
  'Lucas becomes a manager under Max'
);
select throws_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000b1', 'Max Manager', 'manager',
       '00000000-0000-4000-8000-0000000000c2', 'US', 'IL', 'America/Chicago') $$,
  '22023', 'reporting_loop', 'no reporting loops'
);
select throws_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000b1', 'Max Manager', 'employee',
       '00000000-0000-4000-8000-0000000000a1', 'US', 'IL', 'America/Chicago') $$,
  '22023', 'has_reports', 'someone with reports can''t become an employee'
);
select throws_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000a1', 'Ada Admin', 'admin',
       '00000000-0000-4000-8000-0000000000b1', 'US', 'NY', 'America/New_York') $$,
  '42501', 'cannot_change_own_role', 'nobody changes their own role'
);
select throws_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000b1', 'Max Manager', 'owner',
       null, 'US', 'IL', 'America/Chicago') $$,
  '42501', 'cannot_change_owner', 'ownership can''t be handed out here'
);

-- Invites: only the service role (the Edge Function) adds members.
select throws_ok(
  $$ select public.add_invited_member('00000000-0000-4000-8000-0000000000a1',
       '00000000-0000-4000-8000-0000000000d1', 'new@acme.test', 'Nora New', 'employee',
       '00000000-0000-4000-8000-0000000000b1', 'US', 'NY', 'America/New_York') $$,
  '42501', null, 'signed-in users cannot call add_invited_member'
);

select pg_temp.act_as_postgres();
insert into auth.users (id, email) values (:newbie, 'new@acme.test');
set local role service_role;
select throws_ok(
  $$ select public.add_invited_member('00000000-0000-4000-8000-0000000000c2',
       '00000000-0000-4000-8000-0000000000d1', 'new@acme.test', 'Nora New', 'employee',
       '00000000-0000-4000-8000-0000000000b1', 'US', 'NY', 'America/New_York') $$,
  '42501', 'admin_only', 'the inviter must be an owner or admin'
);
select throws_ok(
  $$ select public.add_invited_member('00000000-0000-4000-8000-0000000000a1',
       null, 'ERIN@acme.test', 'Erin Again', 'employee',
       '00000000-0000-4000-8000-0000000000b1', 'US', 'NY', 'America/New_York') $$,
  '23505', 'already_a_member', 'the check-only call refuses an existing member before any email'
);
select lives_ok(
  $$ select public.add_invited_member('00000000-0000-4000-8000-0000000000a1',
       '00000000-0000-4000-8000-0000000000d1', ' New@Acme.test ', 'Nora New', 'employee',
       '00000000-0000-4000-8000-0000000000b1', 'US', 'NY', 'America/New_York') $$,
  'an admin''s invite adds the member'
);
reset role;
select results_eq(
  $$ select org_id, email, role::text, manager_id from public.users where id = '00000000-0000-4000-8000-0000000000d1' $$,
  $$ values ('00000000-0000-4000-8000-000000000001'::uuid, 'new@acme.test', 'employee',
             '00000000-0000-4000-8000-0000000000b1'::uuid) $$,
  'in the inviter''s org, with the manager given'
);
select is((select action from public.audit_log where target_user_id = :newbie), 'member.invited',
  'the invite is logged');

-- The log can't be rewritten, and only owners/admins read it.
select throws_ok(
  $$ update public.audit_log set action = 'member.nothing' $$,
  '42501', 'audit_log_is_append_only', 'the audit log is append-only'
);
select pg_temp.act_as(:max);
select is((select count(*)::int from public.audit_log), 0, 'a manager cannot read the audit log');

select * from finish();
rollback;
