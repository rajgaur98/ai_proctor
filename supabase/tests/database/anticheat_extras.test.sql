-- Anti-cheat extras (#63; ANT-03, ANT-05, ANT-06, ANT-07, DSH-08): the new check-in flags
-- become "needs review" rows, and reports count them.
begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set max '''00000000-0000-4000-8000-0000000000b1'''

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

delete from public.anticheat_flags;
delete from public.checkin_events;
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001', :erin,
        'macos', '15', '0.1.0', 'hash-erin-anticheat-extras-1'),
       ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-000000000001', :lucas,
        'windows', '11', '0.1.0', 'hash-lucas-anticheat-extras');

-- A check-in for `who` at `at` (2026-03-10 18:00 UTC is 11:00 in Los Angeles).
create function pg_temp.ci(
  who uuid, at timestamptz, fl text[], o public.checkin_outcome default 'pass'
) returns uuid
language sql as $$
  insert into public.checkin_events (
    id, org_id, user_id, device_id, scheduled_at, shown_at, responded_at, outcome, response_ms, flags
  )
  values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', who,
          (select d.id from public.devices d where d.user_id = who limit 1),
          at, at, case when o = 'miss' then null else at + interval '4 seconds' end,
          o, case when o = 'miss' then null else 4000 end, fl)
  returning id
$$;

create function pg_temp.details(k public.anticheat_kind, who uuid default '00000000-0000-4000-8000-0000000000c1')
returns jsonb
language sql as $$
  select details from public.anticheat_flags where user_id = who and kind = k
$$;

-- ANT-03: synthetic clicks (macOS, let through) ----------------------------------------------

create temp table s1 as select pg_temp.ci(:erin, timestamptz '2026-03-10 18:00:00+00', '{synthetic_click:2}') as id;
select results_eq(
  $$ select day, (details ->> 'clicks')::int, details -> 'checkin_ids' ->> 0
     from public.anticheat_flags where kind = 'synthetic_click' $$,
  $$ select date '2026-03-10', 2, (select id::text from s1) $$,
  'synthetic_click:2 is a synthetic_click flag on the local day with the clicks and the check-in');
select pg_temp.ci(:erin, timestamptz '2026-03-10 19:00:00+00', '{synthetic_click}', 'miss');
select results_eq(
  $$ select (details ->> 'clicks')::int, jsonb_array_length(details -> 'checkin_ids')
     from public.anticheat_flags where kind = 'synthetic_click' $$,
  $$ values (3, 2) $$,
  'a bare flag is one click, a miss carries it too, and the day adds up');
select is((select outcome::text from public.checkin_events where id = (select id from s1)), 'pass',
  'the check-in is still a pass');

-- ANT-05: virtual cameras ------------------------------------------------------------------------

select pg_temp.ci(:erin, timestamptz '2026-03-10 18:10:00+00', '{"virtual_camera:OBS Virtual Camera"}');
select is(pg_temp.details('virtual_camera') -> 'cameras', '["OBS Virtual Camera"]'::jsonb, 'the camera is named');
select pg_temp.ci(:erin, timestamptz '2026-03-10 18:40:00+00', '{"virtual_camera:ManyCam Virtual Webcam"}');
select pg_temp.ci(:erin, timestamptz '2026-03-10 19:10:00+00', '{"virtual_camera:OBS Virtual Camera"}');
select pg_temp.ci(:erin, timestamptz '2026-03-10 19:40:00+00', '{virtual_camera}');
select results_eq(
  $$ select (details ->> 'count')::int, details -> 'cameras', jsonb_array_length(details -> 'checkin_ids')
     from public.anticheat_flags where kind = 'virtual_camera' $$,
  $$ values (4, '["ManyCam Virtual Webcam", "OBS Virtual Camera"]'::jsonb, 4) $$,
  'four check-ins, each camera listed once, a bare flag counts without a name');

-- ANT-06: duplicate frames -----------------------------------------------------------------------

select pg_temp.ci(:erin, timestamptz '2026-03-10 20:00:00+00', '{duplicate_frame:2}');
select pg_temp.ci(:erin, timestamptz '2026-03-10 20:30:00+00', '{duplicate_frame:0}');
select pg_temp.ci(:erin, timestamptz '2026-03-10 21:00:00+00', '{duplicate_frame:3}');
select results_eq(
  $$ select (details ->> 'count')::int, (details ->> 'min_distance')::int, jsonb_array_length(details -> 'checkin_ids')
     from public.anticheat_flags where kind = 'duplicate_frame' $$,
  $$ values (3, 0, 3) $$,
  'duplicate frames: the count, the closest match and the check-ins');

-- ANT-07: virtual machine and remote session -----------------------------------------------------

create temp table e1 as select pg_temp.ci(:erin, timestamptz '2026-03-10 21:30:00+00', '{virtual_machine,remote_session,injected_click:1}') as id;
select results_eq(
  $$ select kind::text, (details ->> 'count')::int from public.anticheat_flags
     where kind in ('virtual_machine', 'remote_session') order by kind::text $$,
  $$ values ('remote_session', 1), ('virtual_machine', 1) $$,
  'one check-in can raise a VM and a remote-session flag');
select is((pg_temp.details('injected_click') ->> 'clicks')::int, 1, 'next to an injected-click one');
select pg_temp.ci(:erin, timestamptz '2026-03-11 18:00:00+00', '{virtual_machine}');
select is((select count(*)::int from public.anticheat_flags where kind = 'virtual_machine'), 2,
  'another day is another row');
select is((select count(*)::int from public.anticheat_flags where user_id = :erin and day = '2026-03-10'), 6,
  'Erin''s 10th: one row per kind');

-- Anything else is ignored and never fails the event ------------------------------------------------

select lives_ok($$ select pg_temp.ci('00000000-0000-4000-8000-0000000000c2', timestamptz '2026-03-10 18:00:00+00',
  '{duplicate_frame:257,duplicate_frame,duplicate_frame:-1,"virtual_camera:bad:name","virtual_camera:a name that is far too long for it",synthetic_click:abc,synthetic_click:9999999,remote_session:1,VIRTUAL_MACHINE,excluded_app}') $$,
  'malformed flags are accepted on the check-in');
select is((select count(*)::int from public.anticheat_flags where user_id = :lucas), 0, 'and raise nothing');
select pg_temp.ci(:lucas, timestamptz '2026-03-10 18:30:00+00', '{synthetic_click:0}');
select is((select count(*)::int from public.anticheat_flags where user_id = :lucas), 0, 'zero clicks raise nothing');

-- How a day's numbers add up ----------------------------------------------------------------------

select is(
  internal.anticheat_merge('{"count": 2, "min_distance": 1, "checkin_ids": ["a", "b"]}',
                           '{"count": 1, "min_distance": 0, "checkin_ids": ["c"]}'),
  '{"count": 3, "min_distance": 0, "checkin_ids": ["a", "b", "c"]}'::jsonb,
  'merge adds counts, keeps the smallest distance and lists the check-ins');

-- DSH-08: reports count the flags and what still needs review ---------------------------------------

select pg_temp.act_as(:max);
create function pg_temp.report(p_from date, p_to date, who uuid) returns jsonb
language sql as $$
  select r from jsonb_array_elements(public.report_rows(p_from, p_to) -> 'rows') r
  where r ->> 'user_id' = who::text
$$;
select results_eq(
  $$ select (r ->> 'anomaly_flags')::int, (r ->> 'needs_review')::int
     from pg_temp.report('2026-03-10', '2026-03-11', '00000000-0000-4000-8000-0000000000c1') r $$,
  $$ values (7, 7) $$,
  'Erin''s report: seven flags, all needing review');
select results_eq(
  $$ select (r ->> 'anomaly_flags')::int, (r ->> 'needs_review')::int
     from pg_temp.report('2026-03-11', '2026-03-11', '00000000-0000-4000-8000-0000000000c1') r $$,
  $$ values (1, 1) $$,
  'only the report''s days count');
select results_eq(
  $$ select (r ->> 'anomaly_flags')::int, (r ->> 'needs_review')::int
     from pg_temp.report('2026-03-10', '2026-03-11', '00000000-0000-4000-8000-0000000000c2') r $$,
  $$ values (0, 0) $$,
  'Lucas has none');
select lives_ok(
  $$ select public.anticheat_mark_reviewed((select id from public.anticheat_flags where kind = 'virtual_camera'), 'OBS for a demo') $$,
  'Max reviews the virtual-camera flag');
select results_eq(
  $$ select (r ->> 'anomaly_flags')::int, (r ->> 'needs_review')::int
     from pg_temp.report('2026-03-10', '2026-03-11', '00000000-0000-4000-8000-0000000000c1') r $$,
  $$ values (7, 6) $$,
  'a reviewed flag still counts but no longer needs review');
select ok((select (public.report_rows('2026-03-10', '2026-03-11') -> 'rows') @> '[{"full_name": "Erin Employee"}]'),
  'the rest of the report is as before');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.audit_log where action = 'anticheat.reviewed'
             and metadata ->> 'kind' = 'virtual_camera'), 1, 'the review is audit-logged with its kind');

-- Who sees them: the employee about themselves, not about others ---------------------------------------

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.anticheat_flags), 7, 'Erin sees her own flags');
select results_eq(
  $$ select kind::text from public.anticheat_flags where reviewed_at is not null $$,
  $$ values ('virtual_camera') $$,
  'and which one was reviewed');
select throws_ok(
  $$ select public.anticheat_mark_reviewed((select id from public.anticheat_flags where kind = 'duplicate_frame')) $$,
  '42501', 'flag_not_found', 'but can''t review her own');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.anticheat_flags), 0, 'Lucas can''t see Erin''s');

-- Through the agent RPC: the contract accepts the new flags --------------------------------------------

select pg_temp.act_as_postgres();
delete from public.anticheat_flags;
select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '15', '0.1.0', 'hash-erin-anticheat-extras');
create temp table ids (c uuid);
insert into ids values (gen_random_uuid());
grant select on dev, ids to authenticated;
create function pg_temp.ts(ago interval) returns text
language sql as $$ select to_char((now() - ago) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
create temp table reply as select public.agent_events((select device_id from dev), jsonb_build_array(
  jsonb_build_object('id', gen_random_uuid(), 'seq', 1, 'type', 'clock_in', 'at', pg_temp.ts('1 hour'),
    'mono_ms', 1, 'payload', '{"reason": "manual"}'::jsonb),
  jsonb_build_object('id', (select c from ids), 'seq', 2, 'type', 'checkin', 'at', pg_temp.ts('20 minutes'),
    'mono_ms', 2, 'payload', jsonb_build_object('scheduled_at', pg_temp.ts('20 minutes'), 'outcome', 'pass',
      'response_ms', 3000, 'wrong_clicks', 0, 'object_keys', '[]'::jsonb,
      'flags', '["synthetic_click:1", "virtual_camera:OBS Virtual Camera", "duplicate_frame:2", "virtual_machine", "remote_session"]'::jsonb))
)) as r;
grant select on reply to authenticated;
select is((select jsonb_array_length(r -> 'rejected') from reply), 0, 'the agent''s check-in is accepted');
select pg_temp.act_as_postgres();
select results_eq(
  $$ select kind::text from public.anticheat_flags order by kind::text $$,
  $$ values ('duplicate_frame'), ('remote_session'), ('synthetic_click'), ('virtual_camera'), ('virtual_machine') $$,
  'and each flag raises its kind');

select * from finish();
rollback;
