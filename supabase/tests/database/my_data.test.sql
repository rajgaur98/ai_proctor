begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

\set org '''00000000-0000-4000-8000-000000000001'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set e_checkin '''00000000-0000-4000-8000-0000000000f1'''
\set l_checkin '''00000000-0000-4000-8000-0000000000f2'''

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

-- Erin and Lucas each have a passed check-in with a screenshot.
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values
  ('00000000-0000-4000-8000-0000000000d1', :org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-md'),
  ('00000000-0000-4000-8000-0000000000d2', :org, :lucas, 'macos', '26.0', '0.1.0', 'hash-lucas-md');
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome, object_keys)
values
  (:e_checkin, :org, :erin, '00000000-0000-4000-8000-0000000000d1',
   now() - interval '2 hours', 'pass', array['screen-1.webp']),
  (:l_checkin, :org, :lucas, '00000000-0000-4000-8000-0000000000d2',
   now() - interval '2 hours', 'pass', array['screen-1.webp']);

-- Views: Max and Ada open Erin's, Max opens Lucas's, Erin opens her own.
select pg_temp.act_as(:max);
select public.capture_view(:e_checkin);
select public.capture_view(:l_checkin);
select pg_temp.act_as(:ada);
select public.capture_view(:e_checkin);
select pg_temp.act_as(:erin);
select public.capture_view(:e_checkin);

-- An old view (40 days ago) and one from another action: the audit log is append-only
-- for updates, so insert them with explicit times.
select pg_temp.act_as_postgres();
insert into public.audit_log (org_id, actor_id, action, target_user_id, metadata, at)
values
  (:org, :ada, 'capture.viewed', :erin, jsonb_build_object('checkin_id', :e_checkin), now() - interval '40 days'),
  (:org, :ada, 'timesheet.submitted', :erin, '{}'::jsonb, now() - interval '1 hour');

-- Who viewed my captures ------------------------------------------------------------

select pg_temp.act_as(:erin);
select is(
  (select count(*)::int from public.my_capture_views()),
  2, 'Erin sees the two views by others in the last 30 days (not her own, not the old one)'
);
select is(
  (select array_agg(viewer_name order by viewer_name) from public.my_capture_views()),
  array['Ada Admin', 'Max Manager'], 'with the viewer names'
);
select is(
  (select array_agg(viewer_role order by viewer_name) from public.my_capture_views()),
  array['owner', 'manager'], 'and roles'
);
select is(
  (select count(*)::int from public.my_capture_views() where viewer_id = :erin),
  0, 'her own view is logged but not listed'
);
select is(
  (select count(distinct checkin_id)::int from public.my_capture_views() where checkin_id = :e_checkin),
  1, 'each row names the check-in it was about'
);
select ok(
  (select bool_and(checkin_at is not null) from public.my_capture_views()),
  'with the check-in time'
);
select is(
  (select bool_and(viewed_at > now() - interval '5 minutes') from public.my_capture_views()),
  true, 'and when it was viewed'
);
select is(
  (select count(*)::int from public.my_capture_views(60)),
  3, 'a longer window includes the 40-day-old view'
);
select is(
  (select count(*)::int from public.my_capture_views(1)),
  2, 'a one-day window keeps today''s'
);
select is(
  (select count(*)::int from public.my_capture_views(null)),
  2, 'a null window is the default 30 days'
);

select pg_temp.act_as(:lucas);
select is(
  (select array_agg(viewer_name) from public.my_capture_views()),
  array['Max Manager'], 'Lucas sees only views of his own captures'
);
select pg_temp.act_as(:max);
select is(
  (select count(*)::int from public.my_capture_views()),
  0, 'Max, who viewed them, is not the subject: he sees nothing'
);
select pg_temp.act_as(:ada);
select is(
  (select count(*)::int from public.my_capture_views()),
  0, 'neither does an admin, who can read the audit log but is not the subject'
);

select ok(
  not has_function_privilege('anon', 'public.my_capture_views(int)', 'execute')
  and has_function_privilege('authenticated', 'public.my_capture_views(int)', 'execute'),
  'only signed-in users can call it'
);

-- Manager edits ---------------------------------------------------------------------

select pg_temp.act_as_postgres();
insert into public.timesheets (id, org_id, user_id, period_start)
values ('00000000-0000-4000-8000-0000000000e1', :org, :erin, current_date - 6),
       ('00000000-0000-4000-8000-0000000000e2', :org, :lucas, current_date - 6);
insert into public.timesheet_edits (org_id, timesheet_id, user_id, editor_id, kind, start_at, end_at, reason)
values
  (:org, '00000000-0000-4000-8000-0000000000e1', :erin, :max, 'exclude',
   now() - interval '3 hours', now() - interval '2 hours 45 minutes', 'Idle before lunch'),
  (:org, '00000000-0000-4000-8000-0000000000e1', :erin, :max, 'keep',
   now() - interval '5 hours', now() - interval '4 hours', null),
  (:org, '00000000-0000-4000-8000-0000000000e2', :lucas, :max, 'exclude',
   now() - interval '3 hours', now() - interval '2 hours 45 minutes', 'Lucas only');

select pg_temp.act_as(:erin);
select is(
  (select array_agg(reason) from public.my_edit_history()),
  array['Idle before lunch'], 'Erin sees her own edit with its reason; keep decisions and Lucas''s edits are not shown'
);
select is(
  (select editor_name from public.my_edit_history() limit 1),
  'Max Manager', 'with who made it, though she cannot read his users row'
);
select is(
  (select count(*)::int from public.users where id = :max),
  0, '(she cannot read it)'
);

-- Manager ----------------------------------------------------------------------------

select is((select full_name from public.my_manager()), 'Max Manager', 'my_manager is the direct manager');
select pg_temp.act_as(:ada);
select is((select count(*)::int from public.my_manager()), 0, 'the owner has no manager');

-- Activity ---------------------------------------------------------------------------

select pg_temp.act_as_postgres();
insert into public.activity_samples (id, org_id, user_id, device_id, minute, app_name, window_title, domain, seconds)
select gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000d1',
       date_trunc('minute', now() - interval '30 minutes') + make_interval(mins => n), app, title, domain, secs
from (values
  (0, 'VS Code', 'main.rs', null, 60),
  (1, 'VS Code', 'lib.rs', null, 45),
  (2, 'Chrome', 'Jira', 'jira.example.com', 30)
) as v (n, app, title, domain, secs);
insert into public.activity_samples (id, org_id, user_id, device_id, minute, app_name, seconds)
values (gen_random_uuid(), :org, :lucas, '00000000-0000-4000-8000-0000000000d2',
        date_trunc('minute', now() - interval '30 minutes'), 'Slack', 60);

select pg_temp.act_as(:erin);
select is(
  (select jsonb_agg(jsonb_build_object('app', app_name, 'seconds', seconds) order by seconds desc)
   from public.activity_summary(:erin, now() - interval '1 hour', now())),
  '[{"app": "VS Code", "seconds": 105}, {"app": "Chrome", "seconds": 30}]'::jsonb,
  'activity_summary adds up seconds per app'
);
select is(
  (select titles from public.activity_summary(:erin, now() - interval '1 hour', now()) where app_name = 'VS Code'),
  array['lib.rs', 'main.rs'], 'with the window titles seen'
);
select is(
  (select count(*)::int from public.activity_summary(:erin, now() - interval '10 minutes', now())),
  0, 'only the asked range'
);
select pg_temp.act_as(:lucas);
select is(
  (select count(*)::int from public.activity_summary(:erin, now() - interval '1 hour', now())),
  0, 'a peer gets nothing of Erin''s'
);

-- Export helpers: service role only -------------------------------------------------

select pg_temp.act_as_postgres();
insert into storage.objects (bucket_id, name, owner_id, metadata)
values
  ('captures', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c1/2026-10-19/a/screen-1.webp',
   null, '{"size": 1200}'::jsonb),
  ('captures', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c2/2026-10-19/b/screen-1.webp',
   null, '{"size": 900}'::jsonb);

select set_config('role', 'authenticated', true);
select throws_ok(
  format($$ select * from public.export_capture_objects(%L, array['x']) $$, :erin), '42501', null,
  'a signed-in user cannot call export_capture_objects'
);
select throws_ok(
  format($$ select public.record_my_data_export(%L, '{}') $$, :erin), '42501', null,
  'nor record_my_data_export'
);

select set_config('role', 'service_role', true);
select is(
  (select array_agg(name || ':' || bytes) from public.export_capture_objects(:erin, array[
    '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c1/2026-10-19/a/screen-1.webp',
    '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c2/2026-10-19/b/screen-1.webp',
    '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c1/2026-10-19/missing/screen-1.webp'
  ])),
  array['00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c1/2026-10-19/a/screen-1.webp:1200'],
  'the sizes of Erin''s files that exist; another user''s path and missing files are left out'
);
select lives_ok(
  format($$ select public.record_my_data_export(%L, '{"check_ins": 3}') $$, :erin),
  'the service role records an export'
);
select pg_temp.act_as_postgres();
select is(
  (select metadata -> 'counts' ->> 'check_ins' from public.audit_log
   where action = 'my_data.exported' and actor_id = :erin and target_user_id = :erin),
  '3', 'the export is in the audit log with its counts'
);

select * from finish();
rollback;
