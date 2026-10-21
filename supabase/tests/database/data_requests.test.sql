begin;
create extension if not exists pgtap with schema extensions;

select plan(78);

\set org '''00000000-0000-4000-8000-000000000001'''
\set org2 '''00000000-0000-4000-8000-000000000002'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set ann '''00000000-0000-4000-8000-0000000000a2'''
\set olga '''00000000-0000-4000-8000-0000000000a9'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set e_dev '''00000000-0000-4000-8000-0000000000d1'''
\set l_dev '''00000000-0000-4000-8000-0000000000d2'''
\set e_checkin '''00000000-0000-4000-8000-0000000000f1'''
\set l_checkin '''00000000-0000-4000-8000-0000000000f2'''

-- Ann (admin) acts on Erin; Olga is another org's owner.
insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into auth.users (id, email) values (:ann, 'ann@acme.test'), (:olga, 'olga@other.test');
insert into public.users (id, org_id, full_name, email, role, manager_id) values
  (:ann, :org, 'Ann Admin', 'ann@acme.test', 'admin', :ada),
  (:olga, :org2, 'Olga Owner', 'olga@other.test', 'owner', null);

create function pg_temp.act_as(uid uuid, aal text default 'aal1') returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid,
      'claims', jsonb_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- The error text and detail of a statement that is expected to fail.
create function pg_temp.failure(q text) returns text
language plpgsql as $$
declare
  v_detail text;
begin
  execute q;
  return 'no error';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return sqlerrm || ' | ' || coalesce(v_detail, '');
end;
$$;

-- Every public table that points at a person (user_id, recipient_id, delegate_id,
-- manager_id), with how many of its rows point at `u`. Partitions are read through
-- their parent. A table added later that does so is picked up here automatically.
create function pg_temp.pointing_tables(u uuid, p_cols text[] default array['user_id', 'recipient_id', 'delegate_id', 'manager_id'])
returns table (tbl text, col text, n bigint)
language plpgsql as $$
declare
  r record;
begin
  for r in
    select c.table_name::text t, c.column_name::text col
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public' and tb.table_type = 'BASE TABLE'
      and c.column_name = any (p_cols)
    order by 1, 2
  loop
    tbl := r.t; col := r.col;
    execute format('select count(*) from public.%I where %I = $1', r.t, r.col) into n using u;
    return next;
  end loop;
end;
$$;

-- Rows owned by a person (user_id only), as table -> count.
create function pg_temp.owned(u uuid) returns jsonb
language sql as $$
  select coalesce(jsonb_object_agg(tbl, n), '{}'::jsonb)
  from pg_temp.pointing_tables(u, array['user_id']);
$$;

-- One row in every per-user table for `u`, whose device is `dev`.
create function pg_temp.fill(u uuid, dev uuid, slug text) returns void
language plpgsql as $$
declare
  v_session uuid := gen_random_uuid();
  v_clock uuid := gen_random_uuid();
  v_ts uuid := gen_random_uuid();
  v_project uuid;
  v_notice uuid;
begin
  insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
  values (dev, '00000000-0000-4000-8000-000000000001', u, 'macos', '26.0', '0.1.0', 'hash-' || slug);
  insert into public.device_sessions (session_id, device_id, user_id, org_id)
  values (v_session, dev, u, '00000000-0000-4000-8000-000000000001');
  insert into public.last_seen (user_id, org_id, device_id, at)
  values (u, '00000000-0000-4000-8000-000000000001', dev, now());
  insert into public.agent_events_raw (id, org_id, device_id, user_id, seq, type, at)
  values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', dev, u, 1, 'heartbeat', now());
  insert into public.agent_event_rejections (device_id, event_id, seq, type, reason)
  values (dev, gen_random_uuid(), 2, 'heartbeat', 'test');
  insert into public.activity_samples (id, org_id, user_id, device_id, minute, app_name, seconds)
  values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', u, dev,
          date_trunc('minute', now()), 'Editor', 60);
  insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome, object_keys)
  values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', u, dev,
          now() - interval '3 hours', 'pass', array['screen-1.webp']);
  insert into public.status_periods (org_id, user_id, status, start_at, end_at)
  values ('00000000-0000-4000-8000-000000000001', u, 'active', now() - interval '3 hours', now() - interval '2 hours');
  insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
  values ('00000000-0000-4000-8000-000000000001', u, current_date,
          now() - interval '3 hours', now() - interval '2 hours', 'verified', true, false);
  insert into public.clock_sessions (id, org_id, user_id, device_id, start_at, end_at, start_event_id)
  values (v_clock, '00000000-0000-4000-8000-000000000001', u, dev,
          now() - interval '4 hours', now() - interval '1 hour', gen_random_uuid());
  insert into public.breaks (org_id, user_id, clock_session_id, start_at, end_at)
  values ('00000000-0000-4000-8000-000000000001', u, v_clock, now() - interval '2 hours', now() - interval '90 minutes');
  insert into public.pauses (org_id, user_id, clock_session_id, start_at, end_at, planned_min, private_reason)
  values ('00000000-0000-4000-8000-000000000001', u, v_clock, now() - interval '80 minutes',
          now() - interval '70 minutes', 10, 'private');
  insert into public.timesheets (id, org_id, user_id, period_start)
  values (v_ts, '00000000-0000-4000-8000-000000000001', u, date_trunc('week', now())::date);
  insert into public.timesheet_edits (org_id, timesheet_id, user_id, editor_id, kind, start_at, end_at, reason)
  values ('00000000-0000-4000-8000-000000000001', v_ts, u, '00000000-0000-4000-8000-0000000000b1',
          'exclude', now() - interval '3 hours', now() - interval '2 hours', 'test');
  insert into public.manual_entries (org_id, user_id, start_at, end_at, reason)
  values ('00000000-0000-4000-8000-000000000001', u, now() - interval '8 hours', now() - interval '7 hours', 'offline work');
  insert into public.notifications (org_id, user_id, kind)
  values ('00000000-0000-4000-8000-000000000001', u, 'timesheet.returned');
  insert into public.anticheat_flags (org_id, user_id, day, kind)
  values ('00000000-0000-4000-8000-000000000001', u, current_date, 'fast_response');
  insert into public.alerts (org_id, user_id, recipient_id, kind, episode)
  values ('00000000-0000-4000-8000-000000000001', u, '00000000-0000-4000-8000-0000000000b1', 'offline', slug);
  insert into public.reminders_sent (org_id, kind, user_id, period_start, recipient_id)
  values ('00000000-0000-4000-8000-000000000001', 'submit', u, current_date, u);
  insert into public.email_outbox (org_id, to_email, template, payload)
  values ('00000000-0000-4000-8000-000000000001', 'manager@acme.test', 'alert',
          jsonb_build_object('employee_id', u, 'employee_name', slug));
  select n.id into v_notice from public.notices n
  where n.org_id = '00000000-0000-4000-8000-000000000001' order by n.version limit 1;
  -- The seed already acknowledged it for the seed users.
  insert into public.notice_acks (user_id, notice_id) values (u, v_notice) on conflict do nothing;
  insert into public.projects (org_id, name)
  select '00000000-0000-4000-8000-000000000001', 'Project ' || slug returning id into v_project;
  insert into public.project_members (project_id, user_id, org_id)
  values (v_project, u, '00000000-0000-4000-8000-000000000001');
  insert into public.dirty_days (user_id, day) values (u, current_date) on conflict do nothing;
  -- #67: a late clock-in, the digest setting, a digest sent to them and one about them.
  insert into public.late_clock_ins (org_id, user_id, clock_session_id, day, shift_start,
    clocked_in_at, late_s, grace_min)
  values ('00000000-0000-4000-8000-000000000001', u, v_clock, current_date,
          now() - interval '5 hours', now() - interval '4 hours', 3600, 15)
  on conflict do nothing;
  insert into public.notification_prefs (user_id, org_id, daily_digest)
  values (u, '00000000-0000-4000-8000-000000000001', false);
  insert into public.digests_sent (org_id, recipient_id, day)
  values ('00000000-0000-4000-8000-000000000001', u, current_date - 1);
  insert into public.email_outbox (org_id, to_email, template, payload)
  values ('00000000-0000-4000-8000-000000000001', 'manager@acme.test', 'digest',
          jsonb_build_object('day', current_date - 1,
            'reports', jsonb_build_array(jsonb_build_object('user_id', u, 'full_name', slug))));
end;
$$;

select pg_temp.fill(:erin, :e_dev, 'erin');
select pg_temp.fill(:lucas, :l_dev, 'lucas');
-- The emails: one to Erin herself, and about Lucas to his manager (Erin's is above).
insert into public.email_outbox (org_id, to_email, template, payload)
values (:org, 'erin@acme.test', 'alert', jsonb_build_object('recipient_name', 'Erin Employee'));
-- Delegations: Max to Erin, Erin to Max (the other direction), and Max to Lucas.
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on) values
  (:org, :max, :erin, current_date, current_date + 5),
  (:org, :erin, :max, current_date, current_date + 5),
  (:org, :max, :lucas, current_date, current_date + 5);
-- Alerts and reminders addressed to Erin about someone else.
insert into public.alerts (org_id, user_id, recipient_id, kind, episode)
values (:org, :ada, :erin, 'offline', 'to-erin');
insert into public.reminders_sent (org_id, kind, user_id, period_start, recipient_id)
values (:org, 'approval', :ada, current_date, :erin);
-- Erin's mark on Lucas's records: she approved his sheet, decided his entry, excluded a
-- segment and edited his timesheet; she also published a notice.
update public.timesheets set status = 'approved', approver_id = :erin, approved_at = now()
where user_id = :lucas;
update public.manual_entries set status = 'approved', decided_by = :erin, decided_at = now()
where user_id = :lucas;
update public.time_segments set excluded = true, excluded_by = :erin, excluded_reason = 'x'
where user_id = :lucas;
insert into public.timesheet_edits (org_id, timesheet_id, user_id, editor_id, kind, start_at, end_at, reason)
select :org, t.id, :lucas, :erin, 'exclude', now() - interval '3 hours', now() - interval '2 hours', 'by erin'
from public.timesheets t where t.user_id = :lucas;
insert into public.notices (org_id, version, region, body, collection, published_by)
select org_id, 2, region, body, collection, :erin from public.notices
where org_id = :org and version = 1;
-- Captures in Storage for both, and audit rows: Ada and Max viewed Erin's, Erin viewed Lucas's.
insert into storage.objects (bucket_id, name) values
  ('captures', :org::text || '/' || :erin::text || '/2026-10-20/' || :e_checkin::text || '/screen-1.webp'),
  ('captures', :org::text || '/' || :erin::text || '/2026-10-20/' || :e_checkin::text || '/webcam.webp'),
  ('captures', :org::text || '/' || :lucas::text || '/2026-10-20/' || :l_checkin::text || '/screen-1.webp');
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome, object_keys)
values (:e_checkin, :org, :erin, :e_dev, now() - interval '2 hours', 'pass', array['screen-1.webp', 'webcam.webp']),
       (:l_checkin, :org, :lucas, :l_dev, now() - interval '2 hours', 'pass', array['screen-1.webp']);

select internal.audit(:org, :ada, 'capture.viewed', :erin, jsonb_build_object('checkin_id', :e_checkin));
select internal.audit(:org, :max, 'capture.viewed', :erin, jsonb_build_object('checkin_id', :e_checkin));
select internal.audit(:org, :erin, 'capture.viewed', :lucas, jsonb_build_object('checkin_id', :l_checkin));
select internal.audit(:org, :erin, 'timesheet.submitted', :erin, '{}'::jsonb);

-- Audit snapshots ------------------------------------------------------------------------

select is(
  (select actor_name || ' -> ' || target_name from public.audit_log
   where action = 'capture.viewed' and actor_id = :ada and target_user_id = :erin),
  'Ada Admin -> Erin Employee', 'an audit row carries the names of both people when it is written'
);
select is(
  (select count(*)::int from pg_constraint
   where conrelid = 'public.audit_log'::regclass and contype = 'f'),
  1, 'audit_log has no foreign key to a user (only to its org)'
);
select is(
  (select confdeltype from pg_constraint where conname = 'audit_log_org_id_fkey'),
  'r', 'and the org key refuses a delete instead of cascading to the log (AUD-03)'
);
select ok(
  (select tgenabled = 'O' from pg_trigger where tgname = 'audit_log_no_update'),
  'the append-only trigger is back on after the backfill'
);
select throws_ok(
  $$ update public.audit_log set actor_name = 'x' $$,
  '42501', 'audit_log_is_append_only', 'so an UPDATE of the log is still refused'
);
select throws_ok(
  $$ delete from public.orgs where id = '00000000-0000-4000-8000-000000000001' $$,
  '23503', null, 'an org with an audit log cannot be deleted'
);

-- Everything is in place for Erin ---------------------------------------------------------

select is_empty(
  $$ select tbl || '.' || col from pg_temp.pointing_tables('00000000-0000-4000-8000-0000000000c1')
     where n = 0 and tbl not in ('users') $$,
  'every table that points at a person has a row for Erin (add new tables to this test)'
);
select cmp_ok(
  (select count(*)::int from pg_temp.pointing_tables(:erin)), '>=', 25,
  'and the check looks at a real number of tables'
);

-- The append-only triggers still refuse every other change ----------------------------------

select throws_ok(
  $$ update public.timesheet_edits set reason = 'changed' $$,
  '42501', 'timesheet_edits_are_append_only', 'a timesheet edit cannot be changed'
);
select throws_ok(
  $$ update public.timesheet_edits set editor_id = '00000000-0000-4000-8000-0000000000a1'
     where editor_id = '00000000-0000-4000-8000-0000000000c1' $$,
  '42501', 'timesheet_edits_are_append_only', 'nor its editor changed to someone else'
);
select throws_ok(
  $$ update public.notices set version = 99 $$,
  '42501', 'notice_history_is_append_only', 'a published notice cannot be changed'
);

-- Who may ask ---------------------------------------------------------------------------

select pg_temp.act_as(:lucas);
select throws_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test', 'export') $$,
  '42501', 'admin_only', 'an employee cannot ask for anyone''s data'
);
select pg_temp.act_as(:max);
select throws_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test', 'export') $$,
  '42501', 'admin_only', 'nor a manager, even of that person'
);
select throws_ok(
  $$ select public.delete_user_data('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test') $$,
  '42501', 'admin_only', 'or delete it'
);
select pg_temp.act_as(:olga);
select throws_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test', 'export') $$,
  '42501', 'user_not_found', 'another org''s owner does not see her at all'
);
select throws_ok(
  $$ select public.delete_user_data('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test') $$,
  '42501', 'user_not_found', 'nor delete her'
);

select pg_temp.act_as(:ann);
select throws_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000c1', 'lucas@acme.test', 'export') $$,
  '22023', 'email_mismatch', 'the typed email must be the person''s own'
);
select throws_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000c1', null, 'delete') $$,
  '22023', 'email_mismatch', 'and must be there'
);
select throws_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test', 'wipe') $$,
  '22023', 'invalid_action', 'the action is export or delete'
);
select throws_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000a1', 'admin@acme.test', 'export') $$,
  '42501', 'owner_only', 'an admin cannot act on the owner'
);
select is(
  (select public.begin_user_data_request('00000000-0000-4000-8000-0000000000c1', '  ERIN@acme.test ', 'export')
     ->> 'full_name'),
  'Erin Employee', 'an admin passes with the email in any case, and gets the name back'
);
select is(
  (select active from public.users where id = :erin), true,
  'an export request changes nothing about the person'
);

-- MFA (NFR-SEC-05): when the org requires it, the admin's token needs aal2.
select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"require_admin_mfa": true}' where id = :org;
select pg_temp.act_as(:ann);
select throws_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test', 'export') $$,
  '42501', 'mfa_required', 'without MFA the request is refused when the org requires it'
);
select pg_temp.act_as(:ann, 'aal2');
select lives_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test', 'export') $$,
  'and passes with an MFA-verified session'
);
select pg_temp.act_as_postgres();
update public.orgs set policy = policy - 'require_admin_mfa' where id = :org;

-- Export helpers ------------------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'public.record_user_data_export(uuid, uuid, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.record_user_data_export(uuid, uuid, jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.record_user_data_export(uuid, uuid, jsonb)', 'execute'),
  'the export audit row can only be written by the service role'
);
select ok(
  not has_function_privilege('authenticated', 'public.list_user_capture_objects(uuid, int)', 'execute')
  and not has_function_privilege('authenticated', 'public.export_user_capture_views(uuid, int)', 'execute')
  and not has_function_privilege('anon', 'public.begin_user_data_request(uuid, text, text)', 'execute')
  and not has_function_privilege('anon', 'public.delete_user_data(uuid, text)', 'execute'),
  'the Storage and audit readers are closed to users, and the requests to anon'
);
select lives_ok(
  $$ select public.record_user_data_export('00000000-0000-4000-8000-0000000000a2',
       '00000000-0000-4000-8000-0000000000c1', '{"check_ins": 2}') $$,
  'the service role records an export for an admin'
);
select throws_ok(
  $$ select public.record_user_data_export('00000000-0000-4000-8000-0000000000c2',
       '00000000-0000-4000-8000-0000000000c1', '{}') $$,
  '42501', 'admin_only', 'but not for an employee as the actor'
);
select throws_ok(
  $$ select public.record_user_data_export('00000000-0000-4000-8000-0000000000a9',
       '00000000-0000-4000-8000-0000000000c1', '{}') $$,
  '42501', 'admin_only', 'nor for another org''s admin'
);
select results_eq(
  $$ select actor_id, target_user_id, actor_name, target_name, metadata
     from public.audit_log where action = 'user_data.exported' $$,
  $$ values ('00000000-0000-4000-8000-0000000000a2'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid,
             'Ann Admin', 'Erin Employee', '{"counts": {"check_ins": 2}}'::jsonb) $$,
  'the export is in the audit log: admin, person and counts (AUD-01)'
);
select results_eq(
  $$ select viewer_name from public.export_user_capture_views('00000000-0000-4000-8000-0000000000c1')
     order by viewer_name $$,
  $$ values ('Ada Admin'), ('Max Manager') $$,
  'the capture views for the export are other people''s, by name'
);
select results_eq(
  $$ select name from public.list_user_capture_objects('00000000-0000-4000-8000-0000000000c1') order by name $$,
  $$ values ('00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c1/2026-10-20/00000000-0000-4000-8000-0000000000f1/screen-1.webp'),
            ('00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c1/2026-10-20/00000000-0000-4000-8000-0000000000f1/webcam.webp') $$,
  'the capture files listed for deletion are only the person''s own folder'
);

-- Refusals before a deletion ----------------------------------------------------------

select pg_temp.act_as(:ann);
select throws_ok(
  $$ select public.delete_user_data('00000000-0000-4000-8000-0000000000a2', 'ann@acme.test') $$,
  '22023', 'cannot_delete_self', 'nobody deletes themselves'
);
select throws_ok(
  $$ select public.delete_user_data('00000000-0000-4000-8000-0000000000a1', 'admin@acme.test') $$,
  '42501', 'owner_only', 'an admin cannot delete the owner'
);
select is(
  pg_temp.failure($$ select public.delete_user_data('00000000-0000-4000-8000-0000000000b1', 'manager@acme.test') $$),
  'has_reports | Erin Employee, Lucas Martin',
  'a manager with people still reporting to them is refused, with their names (ORG-05)'
);
select throws_ok(
  $$ select public.delete_user_data('00000000-0000-4000-8000-0000000000c1', 'wrong@acme.test') $$,
  '22023', 'email_mismatch', 'a wrong typed email deletes nothing'
);
select is(
  (select count(*)::int from public.devices where user_id = :erin), 1, 'and nothing changed'
);
select pg_temp.act_as(:lucas);
select throws_ok(
  $$ select public.delete_user_data('00000000-0000-4000-8000-0000000000c2', 'lucas@acme.test') $$,
  '42501', 'admin_only', 'a person cannot delete their own data through the admin call'
);

-- Stopping the person, then Storage, then the rows -----------------------------------------

select pg_temp.act_as(:ann);
select lives_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test', 'delete') $$,
  'a deletion request starts'
);
select is(
  (select active from public.users where id = :erin), false, 'it deactivates the person at once'
);
select is(
  (select count(*)::int from public.devices where user_id = :erin and revoked_at is null),
  0, 'revokes the devices'
);
select is(
  (select count(*)::int from public.device_sessions where user_id = :erin),
  0, 'and ends the sessions'
);
select results_eq(
  $$ select actor_id, metadata from public.audit_log
     where action = 'member.deactivated' and target_user_id = '00000000-0000-4000-8000-0000000000c1' $$,
  $$ values ('00000000-0000-4000-8000-0000000000a2'::uuid, '{"reason": "data_deletion"}'::jsonb) $$,
  'which is audited as a deactivation for data deletion'
);

select throws_ok(
  $$ select public.delete_user_data('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test') $$,
  '55000', 'captures_remain', 'the rows are not deleted while capture files are still in Storage'
);
select is(
  (select count(*)::int from public.checkin_events where user_id = :erin), 2, 'nothing was removed by the refusal'
);

-- The function removes the files through the Storage API; here, the same effect.
select pg_temp.act_as_postgres();
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where bucket_id = 'captures' and starts_with(name, :org::text || '/' || :erin::text || '/');

select is(
  (select count(*)::int from public.list_user_capture_objects(:erin)), 0, 'no files left to list for Erin'
);

-- Numbers before: what Lucas owns, and the audit rows about Erin.
create temp table before_lucas as select pg_temp.owned(:lucas) as owned;
create temp table before_audit as
select count(*)::int as n from public.audit_log where target_user_id = :erin or actor_id = :erin;

select pg_temp.act_as(:ann);
create temp table result as select public.delete_user_data(:erin, 'erin@acme.test') as counts;
select pg_temp.act_as_postgres();

select is(
  (select counts ->> 'clock_sessions' from result), '1', 'the deletion reports what it removed'
);
select ok(
  (select (counts ->> 'agent_events')::int = 1 and (counts ->> 'activity_samples')::int = 1
     and (counts ->> 'devices')::int = 1 and (counts ->> 'delegations')::int = 2
     and (counts ->> 'alerts')::int = 2 and (counts ->> 'email_outbox')::int = 2
   from result),
  'partitioned tables, devices, delegations in both directions, alerts to or about her and her emails are counted'
);

-- The person is gone -------------------------------------------------------------------

select is((select count(*)::int from public.users where id = :erin), 0, 'the users row is gone');
select is(
  (select count(*)::int from auth.users where id = :erin), 0,
  'and the Auth account, so she cannot sign in'
);
select is(
  (select count(*)::int from auth.users where email = 'erin@acme.test'), 0,
  'which frees the email address'
);
select is_empty(
  $$ select tbl || '.' || col || '=' || n from pg_temp.pointing_tables('00000000-0000-4000-8000-0000000000c1')
     where n > 0 $$,
  'no table has a row that points at her any more (partitions included)'
);
select is(
  (select count(*)::int from public.email_outbox
   where template = 'digest' and payload -> 'reports' @> jsonb_build_array(jsonb_build_object('user_id', :erin))),
  0, 'the digests that list her are gone too (#67)'
);
select is(
  (select count(*)::int from public.email_outbox
   where template = 'digest' and payload -> 'reports' @> jsonb_build_array(jsonb_build_object('user_id', :lucas))),
  1, 'but not the ones about someone else'
);

-- Everyone else is untouched ---------------------------------------------------------------

select is(
  pg_temp.owned(:lucas), (select owned from before_lucas), 'Lucas still has every row he had'
);
select is(
  (select count(*)::int from public.list_user_capture_objects(:lucas)), 1,
  'and his capture file'
);
select ok(
  exists (select 1 from public.users where id = :lucas)
  and exists (select 1 from public.users where id = :max)
  and exists (select 1 from public.orgs where id = :org),
  'Lucas, Max and the org are still there'
);
select is(
  (select count(*)::int from public.email_outbox where to_email = 'manager@acme.test'
     and payload ->> 'employee_id' = :lucas::text), 1,
  'the email about Lucas to his manager is kept'
);
select is(
  (select count(*)::int from public.delegations where delegate_id = :lucas), 1,
  'Max''s delegation to Lucas is kept'
);
select ok(
  (select approver_id is null from public.timesheets where user_id = :lucas)
  and (select decided_by is null from public.manual_entries where user_id = :lucas)
  and (select excluded_by is null from public.time_segments where user_id = :lucas),
  'what she approved, decided or excluded of his stays, with no name on it'
);
select is(
  (select count(*)::int from public.timesheet_edits where user_id = :lucas and editor_id is null),
  1, 'her edit of his timesheet stays, with no editor (deleting her was not blocked by the append-only trigger)'
);
select is(
  (select count(*)::int from public.timesheet_edits where user_id = :lucas), 2,
  'and his other edit is untouched'
);
select is(
  (select count(*)::int from public.notices where version = 2 and published_by is null), 1,
  'the notice she published stays, with no publisher'
);

-- The tombstone and the audit log -------------------------------------------------------------

select results_eq(
  $$ select actor_id, target_user_id, actor_name, target_name, metadata ->> 'role',
            jsonb_typeof(metadata -> 'counts')
     from public.audit_log where action = 'user_data.deleted' $$,
  $$ values ('00000000-0000-4000-8000-0000000000a2'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid,
             'Ann Admin', 'Erin Employee', 'employee', 'object') $$,
  'exactly one tombstone: admin, person, role and counts (AUD-01)'
);
select ok(
  (select position('erin@acme.test' in metadata::text) = 0
     and position('erin@acme.test' in coalesce(actor_name, '') || coalesce(target_name, '')) = 0
   from public.audit_log where action = 'user_data.deleted'),
  'it holds no email address'
);
select cmp_ok(
  (select count(*)::int from public.audit_log where target_user_id = :erin or actor_id = :erin),
  '>', (select n from before_audit),
  'the audit rows about her are all still there, plus the tombstone'
);
select results_eq(
  $$ select action, actor_name, target_name from public.audit_log
     where actor_id = '00000000-0000-4000-8000-0000000000c1' order by id $$,
  $$ values ('capture.viewed', 'Erin Employee', 'Lucas Martin'),
            ('timesheet.submitted', 'Erin Employee', 'Erin Employee') $$,
  'rows she acted in still say who she was'
);
select is(
  (select count(*)::int from public.audit_log where action = 'user_data.exported'), 1,
  'and the export entry is kept'
);

select pg_temp.act_as(:lucas);
select results_eq(
  $$ select viewer_name, viewer_role from public.my_capture_views() $$,
  $$ values ('Erin Employee', null::text) $$,
  'Lucas still sees who viewed his captures, by the name written then (no role once the user is gone)'
);

-- Done twice, and a manager after reassigning ------------------------------------------------

select pg_temp.act_as(:ann);
select throws_ok(
  $$ select public.delete_user_data('00000000-0000-4000-8000-0000000000c1', 'erin@acme.test') $$,
  '42501', 'user_not_found', 'deleting the same person again finds nobody'
);
select pg_temp.act_as_postgres();
update public.users set manager_id = :ada where id = :lucas;
select pg_temp.act_as(:ann);
select lives_ok(
  $$ select public.begin_user_data_request('00000000-0000-4000-8000-0000000000b1', 'manager@acme.test', 'delete') $$,
  'once their reports are moved, a manager''s request starts'
);
select pg_temp.act_as_postgres();
select is(
  (select count(*)::int from public.list_user_capture_objects(:max)), 0, 'Max has no capture files'
);
select pg_temp.act_as(:ann);
select lives_ok(
  $$ select public.delete_user_data('00000000-0000-4000-8000-0000000000b1', 'manager@acme.test') $$,
  'and is deleted'
);
select pg_temp.act_as_postgres();
select is(
  (select count(*)::int from public.users where id = :max) + (select count(*)::int from auth.users where id = :max),
  0, 'Max and his account are gone'
);
select is(
  (select count(*)::int from public.alerts where recipient_id = :max), 0,
  'the alerts he received went with him'
);
select is(
  (select count(*)::int from public.alerts where user_id = :lucas), 0,
  'Lucas''s own alert, which was to Max, is gone too (it was Max''s inbox)'
);
select is(
  (select manager_id from public.users where id = :lucas), :ada::uuid,
  'Lucas keeps his new manager'
);
select is(
  (select count(*)::int from public.audit_log where action = 'user_data.deleted'), 2,
  'each deletion has its own tombstone'
);

select * from finish();
rollback;
