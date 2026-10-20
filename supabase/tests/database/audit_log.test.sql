begin;
create extension if not exists pgtap with schema extensions;

select plan(44);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set org '''00000000-0000-4000-8000-000000000001'''

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

-- Append-only: nobody can change or remove a row ----------------------------------------------

select pg_temp.act_as_postgres();
insert into public.audit_log (org_id, actor_id, action, target_user_id, metadata)
values (:org, :ada, 'test.seeded', :erin, '{"n": 1}');

-- Even the table owner runs into the triggers.
select throws_ok($$ update public.audit_log set action = 'test.changed' $$,
  '42501', 'audit_log_is_append_only', 'update is refused for the owner (trigger)');
select throws_ok($$ delete from public.audit_log $$,
  '42501', 'audit_log_is_append_only', 'delete is refused for the owner (trigger)');
select throws_ok($$ truncate public.audit_log $$,
  '42501', 'audit_log_is_append_only', 'truncate is refused for the owner (trigger)');

set local role service_role;
select throws_ok($$ update public.audit_log set action = 'test.changed' $$,
  '42501', null, 'the service role cannot update');
select throws_ok($$ delete from public.audit_log $$,
  '42501', null, 'the service role cannot delete');
select throws_ok($$ truncate public.audit_log $$,
  '42501', null, 'the service role cannot truncate');
select throws_ok($$ insert into public.audit_log (org_id, action) values ('00000000-0000-4000-8000-000000000001', 'test.forged') $$,
  '42501', null, 'the service role cannot write rows directly either');
select throws_ok($$ select count(*) from public.audit_log $$,
  '42501', null, 'and cannot read the table (it goes through the RPCs)');
reset role;

set local role anon;
select throws_ok($$ update public.audit_log set action = 'test.changed' $$,
  '42501', null, 'anon cannot update');
select throws_ok($$ delete from public.audit_log $$,
  '42501', null, 'anon cannot delete');
reset role;

select pg_temp.act_as(:ada);
select throws_ok($$ update public.audit_log set action = 'test.changed' $$,
  '42501', null, 'an admin cannot update');
select throws_ok($$ delete from public.audit_log $$,
  '42501', null, 'an admin cannot delete');
select throws_ok($$ truncate public.audit_log $$,
  '42501', null, 'an admin cannot truncate');
select throws_ok($$ insert into public.audit_log (org_id, action) values ('00000000-0000-4000-8000-000000000001', 'test.forged') $$,
  '42501', null, 'an admin cannot insert directly');
select is((select count(*)::int from public.audit_log where action = 'test.seeded'), 1,
  'but still reads the log through the select policy');

-- The functions that write the log keep working (security definer).
select lives_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000c1', 'Erin Employee', 'manager',
       '00000000-0000-4000-8000-0000000000a1', 'US', 'CA', 'America/Los_Angeles') $$,
  'update_member still writes audit rows'
);
select lives_ok($$ select public.set_user_active('00000000-0000-4000-8000-0000000000c2', false) $$,
  'set_user_active still writes audit rows');
select is((select count(*)::int from public.audit_log where action in
  ('member.role_changed', 'member.manager_changed', 'member.deactivated')), 3,
  'three rows were appended');

-- Search ----------------------------------------------------------------------------------

-- Other migrations and the seed write rows too, so compare with what the select
-- policy shows the admin rather than a fixed number.
select is((select count(*)::int from public.search_audit_log()),
  (select least(count(*), 50)::int from public.audit_log where org_id = :org),
  'an admin sees the whole log');
select results_eq(
  $$ select action, actor_name, target_name from public.search_audit_log(p_actions => array['member.role_changed']) $$,
  $$ values ('member.role_changed', 'Ada Admin', 'Erin Employee') $$,
  'filter by action, with actor and target names'
);
select is(
  (select count(*)::int from public.search_audit_log(p_actions => array['member.role_changed', 'member.deactivated'])),
  2, 'several actions at once'
);
select results_eq(
  $$ select action from public.search_audit_log(p_target_user_id => '00000000-0000-4000-8000-0000000000c2') $$,
  $$ values ('member.deactivated') $$,
  'filter by target'
);
select is((select count(*)::int from public.search_audit_log(p_actor_id => :max)), 0, 'filter by actor');

-- Pages walk the log newest first without repeats (the cursor is the last row).
create temp table page1 as select * from public.search_audit_log(p_limit => 3);
create temp table page2 as
  select * from public.search_audit_log(p_limit => 3,
    p_cursor_at => (select at from page1 order by at, id limit 1),
    p_cursor_id => (select id from page1 order by at, id limit 1));
select is((select count(*)::int from page1), 3, 'first page has the limit');
select is((select count(*)::int from page2),
  (select least(count(*) - 3, 3)::int from public.audit_log where org_id = :org),
  'second page has the rest');
select ok(not exists (select 1 from page1 join page2 using (id)), 'no row on both pages');
select ok((select max(at) from page2) <= (select min(at) from page1), 'and it continues where the first page ended');
select throws_ok($$ select * from public.search_audit_log(p_cursor_at => now()) $$,
  '22023', 'invalid_cursor', 'a half cursor is refused');

-- Days are read in the caller's zone (Ada is on New York time): 03:30 UTC on
-- 10 March is still 9 March there.
select pg_temp.act_as_postgres();
insert into public.audit_log (org_id, actor_id, action, target_user_id, at)
values (:org, :ada, 'test.dated', :erin, '2026-03-10 03:30:00+00');
select pg_temp.act_as(:ada);
select is(
  (select count(*)::int from public.search_audit_log(p_actions => array['test.dated'],
     p_from => '2026-03-09', p_to => '2026-03-09')),
  1, 'the date range uses the viewer''s time zone: in on the 9th'
);
select is(
  (select count(*)::int from public.search_audit_log(p_actions => array['test.dated'],
     p_from => '2026-03-10', p_to => '2026-03-10')),
  0, 'out on the 10th'
);
select is(
  (select count(*)::int from public.search_audit_log(p_actions => array['test.dated'], p_to => '2026-03-08')),
  0, 'open start, early end: out'
);

-- Only owners and admins, with MFA when the org asks for it.
select pg_temp.act_as(:max);
select throws_ok($$ select * from public.search_audit_log() $$, '42501', 'admin_only',
  'a manager cannot search');
select throws_ok($$ select public.export_audit_log() $$, '42501', 'admin_only',
  'a manager cannot export');
select pg_temp.act_as(:erin);
select throws_ok($$ select * from public.search_audit_log() $$, '42501', 'admin_only',
  'an employee cannot search');
select pg_temp.act_as_postgres();
update public.users set role = 'employee' where id = :erin;
update public.orgs set policy = policy || '{"require_admin_mfa": true}' where id = :org;
select pg_temp.act_as(:ada);
select throws_ok($$ select * from public.search_audit_log() $$, '42501', 'mfa_required',
  'with require_admin_mfa, an admin needs an MFA session');
select set_config('request.jwt.claims',
  (current_setting('request.jwt.claims')::jsonb || '{"aal": "aal2"}')::text, true);
select lives_ok($$ select * from public.search_audit_log() $$, 'and gets in with one');
select pg_temp.act_as_postgres();
update public.orgs set policy = policy - 'require_admin_mfa' where id = :org;

-- Export ------------------------------------------------------------------------------------

select pg_temp.act_as(:ada);
create temp table exp as
  select public.export_audit_log(p_actions => array['member.role_changed', 'member.deactivated'],
    p_from => '2026-01-01') as r;
select is(
  (select (r ->> 'row_count')::int from exp), 2, 'the export reports its row count');
select is(
  (select jsonb_array_length(r -> 'rows') from exp), 2, 'and returns the filtered rows');
select is(
  (select r ->> 'timezone' from exp), 'America/New_York', 'with the time zone the days were read in');
select results_eq(
  $$ select action, actor_id, target_user_id, metadata from public.audit_log where action = 'audit_log.exported' $$,
  $$ values ('audit_log.exported', '00000000-0000-4000-8000-0000000000a1'::uuid, null::uuid,
    '{"row_count": 2, "filters": {"actions": ["member.role_changed", "member.deactivated"],
      "from": "2026-01-01", "timezone": "America/New_York"}}'::jsonb) $$,
  'the export is in the log, with who, the filters and the row count'
);
select ok(
  not exists (select 1 from exp, jsonb_array_elements(r -> 'rows') e where e ->> 'action' = 'audit_log.exported'),
  'an export does not contain its own entry'
);
select is(
  (select jsonb_array_length(public.export_audit_log(p_actions => array['audit_log.exported']) -> 'rows')),
  1, 'the next export shows the first one'
);

-- Too much to export in one go is refused, and nothing is logged for it.
select pg_temp.act_as_postgres();
insert into public.audit_log (org_id, actor_id, action, target_user_id)
select :org, :ada, 'test.bulk', :erin from generate_series(1, 50001);
select pg_temp.act_as(:ada);
select throws_ok($$ select public.export_audit_log(p_actions => array['test.bulk']) $$,
  '54000', 'too_many_rows', 'more than 50 000 rows is refused');
select is((select count(*)::int from public.audit_log where action = 'audit_log.exported'), 2,
  'a refused export is not logged (no data left)');

select * from finish();
rollback;
