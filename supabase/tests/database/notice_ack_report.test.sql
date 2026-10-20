begin;
create extension if not exists pgtap with schema extensions;

select plan(32);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set alma '''00000000-0000-4000-8000-0000000000a2'''
\set dan '''00000000-0000-4000-8000-0000000000c3'''
\set zed '''00000000-0000-4000-8000-0000000000e1'''
\set org '''00000000-0000-4000-8000-000000000001'''

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

create function pg_temp.latest() returns uuid
language sql as $$
  select id from public.notices where org_id = '00000000-0000-4000-8000-000000000001' order by version desc limit 1
$$;

-- Setup: a second admin who has not acknowledged, a deactivated employee, and someone in another org.
select pg_temp.act_as_postgres();
insert into auth.users (id, email) values (:alma, 'alma@acme.test'), (:dan, 'dan@acme.test'), (:zed, 'zed@other.test');
insert into public.orgs (id, name, region_preset) values ('00000000-0000-4000-8000-0000000000d1', 'Other Co', 'us');
insert into public.users (id, org_id, full_name, email, role, manager_id, work_country, work_state, timezone, active)
values
  (:alma, :org, 'Alma Admin', 'alma@acme.test', 'admin', :ada, 'US', 'NY', 'America/New_York', true),
  (:dan, :org, 'Dan Deactivated', 'dan@acme.test', 'employee', :max, 'US', 'TX', 'America/Chicago', false),
  (:zed, '00000000-0000-4000-8000-0000000000d1', 'Zed Elsewhere', 'zed@other.test', 'owner', null, 'US', 'NY', 'America/New_York', true);

-- Access ---------------------------------------------------------------------------------------

select pg_temp.act_as(:ada);
select lives_ok($$ select * from public.notice_ack_report() $$, 'an owner reads the report');
select lives_ok($$ select * from public.export_notice_ack_report() $$, 'and exports it');
select pg_temp.act_as(:alma);
select lives_ok($$ select * from public.notice_ack_report() $$, 'an admin reads it too');
select pg_temp.act_as(:max);
select throws_ok($$ select * from public.notice_ack_report() $$, '42501', 'admin_only', 'a manager cannot read the report');
select throws_ok($$ select * from public.export_notice_ack_report() $$, '42501', 'admin_only', 'or export it');
select pg_temp.act_as(:erin);
select throws_ok($$ select * from public.notice_ack_report() $$, '42501', 'admin_only', 'an employee cannot read the report');
select throws_ok($$ select * from public.export_notice_ack_report() $$, '42501', 'admin_only', 'or export it');
select pg_temp.act_as_postgres();
select ok(not has_function_privilege('anon', 'public.notice_ack_report(int)', 'execute')
  and not has_function_privilege('anon', 'public.export_notice_ack_report(int, text)', 'execute'),
  'signed-out callers cannot run either');

-- Rows: only version 1 exists, and the seed acknowledged it for the four seed users --------------------

select pg_temp.act_as(:ada);
select results_eq(
  $$ select full_name, role::text, manager_name, acknowledged_version, acknowledged_current, acknowledged_selected
     from public.notice_ack_report() $$,
  $$ values ('Ada Admin', 'owner', null, 1, true, null::boolean),
            ('Alma Admin', 'admin', 'Ada Admin', null, false, null),
            ('Erin Employee', 'employee', 'Max Manager', 1, true, null),
            ('Lucas Martin', 'employee', 'Max Manager', 1, true, null),
            ('Max Manager', 'manager', 'Ada Admin', 1, true, null) $$,
  'one row per active member of the org, by name: deactivated people and other orgs are left out');
select is((select email from public.notice_ack_report() where full_name = 'Erin Employee'), 'erin@acme.test',
  'with their email');
select is((select count(*)::int from public.notice_ack_report() where acknowledged_version is null), 1,
  'and Alma, who has never acknowledged anything, has no version');
select is((select acknowledged_at from public.notice_ack_report() where full_name = 'Erin Employee'),
  (select a.acknowledged_at from public.notice_acks a join public.notices n on n.id = a.notice_id
   where a.user_id = :erin and n.version = 1),
  'the time is that of the acknowledgement');

-- Across versions ---------------------------------------------------------------------------------------

select is(public.publish_notice(public.notice_template()), 2, 'the admin publishes version 2');
select pg_temp.act_as(:erin);
select lives_ok($$ select public.acknowledge_notice(pg_temp.latest()) $$, 'Erin acknowledges version 2');
select pg_temp.act_as(:ada);
select results_eq(
  $$ select full_name, acknowledged_version, acknowledged_current from public.notice_ack_report() $$,
  $$ values ('Ada Admin', 1, false), ('Alma Admin', null, false), ('Erin Employee', 2, true),
            ('Lucas Martin', 1, false), ('Max Manager', 1, false) $$,
  'the latest version each person acknowledged, and who has the current one');
select is((select acknowledged_at from public.notice_ack_report() where full_name = 'Erin Employee'),
  (select a.acknowledged_at from public.notice_acks a join public.notices n on n.id = a.notice_id
   where a.user_id = :erin and n.version = 2),
  'Erin''s time is for version 2, not version 1');
select results_eq(
  $$ select full_name, acknowledged_selected from public.notice_ack_report(1) $$,
  $$ values ('Ada Admin', true), ('Alma Admin', false), ('Erin Employee', true),
            ('Lucas Martin', true), ('Max Manager', true) $$,
  'asking about version 1 says who acknowledged that one');
select results_eq(
  $$ select full_name from public.notice_ack_report(2) where acknowledged_selected $$,
  $$ values ('Erin Employee') $$,
  'and about version 2');
select throws_ok($$ select * from public.notice_ack_report(9) $$, '22023', 'notice_not_found',
  'a version that does not exist is refused');

-- Export ---------------------------------------------------------------------------------------------------------

select pg_temp.act_as_postgres();
select is((select count(*)::int from public.audit_log where action = 'notice.ack_report_exported'), 1,
  'the export above was logged; reading the report logs nothing');
delete from public.audit_log where action = 'notice.ack_report_exported';
select pg_temp.act_as(:ada);
select results_eq(
  $$ select full_name from public.export_notice_ack_report(null, 'not_yet') $$,
  $$ values ('Ada Admin'), ('Alma Admin'), ('Lucas Martin'), ('Max Manager') $$,
  'the export returns the rows for its filter');
select results_eq(
  $$ select full_name from public.export_notice_ack_report(null, 'acknowledged_current') $$,
  $$ values ('Erin Employee') $$,
  'acknowledged the current version');
select is((select count(*)::int from public.export_notice_ack_report(1)), 5, 'unfiltered, for one version');
select throws_ok($$ select * from public.export_notice_ack_report(null, 'everyone') $$, '22023', 'invalid_filter',
  'an unknown filter is refused');
select pg_temp.act_as_postgres();
select results_eq(
  $$ select actor_id, target_user_id, metadata from public.audit_log
     where org_id = '00000000-0000-4000-8000-000000000001' and action = 'notice.ack_report_exported' order by id $$,
  $$ values ('00000000-0000-4000-8000-0000000000a1'::uuid, null::uuid,
             '{"version": null, "status": "not_yet", "row_count": 4}'::jsonb),
            ('00000000-0000-4000-8000-0000000000a1'::uuid, null,
             '{"version": null, "status": "acknowledged_current", "row_count": 1}'::jsonb),
            ('00000000-0000-4000-8000-0000000000a1'::uuid, null,
             '{"version": 1, "status": "all", "row_count": 5}'::jsonb) $$,
  'each export is audit-logged with who, the filters and the row count; refused ones are not');
select is((select count(*)::int from public.audit_log
  where org_id = '00000000-0000-4000-8000-0000000000d1' and action = 'notice.ack_report_exported'), 0,
  'nothing is logged in another org');

-- MFA ------------------------------------------------------------------------------------------------------------------

update public.orgs set policy = policy || '{"require_admin_mfa": true}' where id = :org;
select pg_temp.act_as(:ada, 'aal1');
select throws_ok($$ select * from public.notice_ack_report() $$, '42501', 'mfa_required',
  'when the org requires MFA, a session without it cannot read the report');
select throws_ok($$ select * from public.export_notice_ack_report() $$, '42501', 'mfa_required', 'or export it');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.audit_log where action = 'notice.ack_report_exported'), 3,
  'and a refused export is not logged');
select pg_temp.act_as(:ada, 'aal2');
select is((select count(*)::int from public.notice_ack_report()), 5, 'with an MFA-verified session it works');
select is((select count(*)::int from public.export_notice_ack_report()), 5, 'and so does the export');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.audit_log where action = 'notice.ack_report_exported'), 4,
  'which is logged');

select * from finish();
rollback;
