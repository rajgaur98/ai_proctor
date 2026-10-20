begin;
create extension if not exists pgtap with schema extensions;

-- #161: Tamper follows what the person is collected for (AGT-07, CAP-02, CAP-05,
-- ACT-03, ANT-01, TS-01, ALR-01). A missing permission is Tamper only when the capture
-- it belongs to is on; the restart-gap and heartbeat-gap periods feed the timesheet
-- segments and the Tamper alert, once per period.

select plan(28);

\set erin '''00000000-0000-4000-8000-0000000000c1'''
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

create function pg_temp.ts(ago interval) returns text
language sql as $$ select to_char((now() - ago) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create temp table seqs (n int);
insert into seqs values (0);
grant all on seqs to authenticated;

-- Sends one event `ago` before now and returns Erin's presence status afterwards.
create function pg_temp.send(type text, payload jsonb default '{}', ago interval default '0')
returns text
language plpgsql as $$
declare
  n int;
begin
  update seqs set n = seqs.n + 1 returning seqs.n into n;
  perform public.agent_events(
    (select device_id from dev),
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'seq', n, 'type', type,
      'at', pg_temp.ts(ago), 'mono_ms', n, 'payload', payload)));
  return (select status::text from public.presence where user_id = '00000000-0000-4000-8000-0000000000c1');
end;
$$;

create function pg_temp.perm(screen text, camera text, ago interval) returns text
language sql as $$
  select pg_temp.send('permission_change', jsonb_build_object('screen', screen, 'camera', camera), ago)
$$;

-- Any event refreshes the status, so this is "the next refresh" after a setting change.
create function pg_temp.refresh(ago interval) returns text
language sql as $$ select pg_temp.send('unlock', '{}', ago) $$;

-- The org's collection settings, then back to Erin (who acknowledged everything).
create function pg_temp.collect(screenshots text, titles boolean, sampling boolean, webcam boolean)
returns void
language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  update public.orgs
  set policy = policy || jsonb_build_object(
    'screenshots', screenshots, 'window_titles', titles, 'activity_sampling', sampling, 'webcam', webcam)
  where id = '00000000-0000-4000-8000-000000000001';
  perform pg_temp.act_as('00000000-0000-4000-8000-0000000000c1');
end;
$$;

create function pg_temp.heartbeat() returns void
language plpgsql as $$
begin
  perform public.agent_heartbeat((select device_id from dev), now(), 0, false, false, '0.1.0', '{}');
end;
$$;

select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-policy');
grant select on dev to authenticated;

select is(pg_temp.send('clock_in', '{"reason": "manual"}', '200 minutes'), 'active', 'clocked in');

-- Screen Recording: needed for screenshots, or for window titles ----------------------------

select pg_temp.collect('off', false, false, false);
select is(pg_temp.perm('denied', 'denied', '195 minutes'), 'active',
  'no screenshots, no titles, no webcam: nothing needs a permission, so missing ones are not Tamper');

select pg_temp.collect('off', true, true, false);
select is(pg_temp.refresh('190 minutes'), 'tamper',
  'window titles are sampled: they need Screen Recording (the setting changed, the next refresh sees it)');

select pg_temp.collect('off', true, false, false);
select is(pg_temp.refresh('185 minutes'), 'active', 'titles on but activity sampling off: nothing is read');

select pg_temp.collect('off', false, true, false);
select is(pg_temp.refresh('180 minutes'), 'active', 'sampling the app name alone needs no Screen Recording');

select pg_temp.collect('blurred', false, false, false);
select is(pg_temp.refresh('175 minutes'), 'tamper', 'blurred screenshots need it');

select is(pg_temp.perm('granted', 'denied', '170 minutes'), 'active',
  'Screen Recording on and the camera off with the webcam off: working');

-- Camera: only while the webcam is on ---------------------------------------------------------

select pg_temp.collect('blurred', false, false, true);
select is(pg_temp.refresh('165 minutes'), 'tamper', 'the webcam is on and the camera is off: Tamper');
select is(pg_temp.perm('granted', 'unsupported', '160 minutes'), 'active',
  'a camera this platform does not have is nothing to fix');
select is(pg_temp.perm('unsupported', 'granted', '155 minutes'), 'active', 'nor is Screen Recording');
select is(pg_temp.perm('restricted', 'granted', '152 minutes'), 'tamper', 'restricted by the device counts');

-- A setting turned off while the permission is missing ends the Tamper at the next refresh.
select pg_temp.collect('off', false, false, true);
select is(pg_temp.refresh('150 minutes'), 'active',
  'screenshots switched off while Screen Recording is missing: the Tamper ends');
select is(
  (select count(*)::int from public.status_periods
   where user_id = :erin and status = 'tamper' and end_at is null),
  0, 'and its period is closed');
select pg_temp.collect('full', false, false, true);
select is(pg_temp.refresh('145 minutes'), 'tamper', 'switched back on while still missing: Tamper again');
select is(pg_temp.perm('granted', 'granted', '140 minutes'), 'active', 'granted: working');

-- What the person is collected for is the acknowledged notice and the org's policy.
select pg_temp.act_as_postgres();
select is(internal.capture_needs(:erin), '{"screen": true, "camera": true}'::jsonb,
  'needs: screenshots and the webcam');
select pg_temp.collect('off', true, true, false);
select pg_temp.act_as_postgres();
select is(internal.capture_needs(:erin), '{"screen": true, "camera": false}'::jsonb, 'needs: titles only');
delete from public.notice_acks where user_id = :erin;
select is(internal.capture_needs(:erin), '{"screen": false, "camera": false}'::jsonb,
  'nothing acknowledged: nothing is collected, so nothing is needed');
insert into public.notice_acks (user_id, notice_id)
select u.id, n.id from public.users u join public.notices n on n.org_id = u.org_id and n.version = 1
where u.id = :erin;
select pg_temp.collect('full', true, true, true);

-- Restart gap and heartbeat gap: segments and alerts --------------------------------------

select pg_temp.act_as(:erin);

-- The agent was killed 14 minutes ago and the watchdog had it back 4 minutes later.
select is(
  pg_temp.send('agent_restart',
    jsonb_build_object('last_alive_at', pg_temp.ts('14 minutes'), 'reason', 'killed'), '10 minutes'),
  'active', 'killed and restarted: working again');

-- Then silent for 5 minutes with nothing to explain it.
select pg_temp.act_as_postgres();
update public.presence set last_contact_at = now() - interval '5 minutes' where user_id = :erin;
select pg_temp.act_as(:erin);
select pg_temp.heartbeat();
select pg_temp.act_as_postgres();

select is(
  (select array_agg(reason::text order by start_at) from public.status_periods
   where user_id = :erin and status = 'tamper' and start_at > now() - interval '20 minutes'),
  array['agent_stopped', 'no_heartbeat'],
  'both gaps are Tamper periods, with their reasons');

-- TS-01: the day's inputs carry both gaps as Tamper status periods, which buildSegments
-- turns into unverified segments (packages/core/src/segments.test.ts).
create temp table seginp as
select jsonb_array_elements(public.segment_inputs(:erin, d::date) -> 'input' -> 'statusPeriods') as p
from generate_series(
  ((now() at time zone (select u.timezone from public.users u where u.id = :erin))::date - 1)::timestamp,
  (now() at time zone (select u.timezone from public.users u where u.id = :erin))::date::timestamp,
  interval '1 day') d;
select is(
  (select count(*)::int from public.status_periods sp
   where sp.user_id = :erin and sp.status = 'tamper' and sp.start_at > now() - interval '20 minutes'
     and exists (
       select 1 from seginp
       where p ->> 'status' = 'tamper'
         and (p ->> 'start')::bigint = floor(extract(epoch from sp.start_at))
         and (p ->> 'end')::bigint = floor(extract(epoch from sp.end_at)))),
  2, 'segment_inputs hands both gaps to buildSegments as Tamper status periods');

-- ALR-01: one Tamper alert per period, whatever the reason.
delete from public.alerts;
select internal.alert_eval();
select is(
  (select array_agg(distinct details ->> 'reason' order by details ->> 'reason')
   from public.alerts where kind = 'tamper' and user_id = :erin),
  array['agent_stopped', 'no_heartbeat'], 'the killed-agent and the heartbeat-gap periods each raise a Tamper alert');
select is((select count(distinct episode)::int from public.alerts where kind = 'tamper' and user_id = :erin),
  2, 'one episode each');
create temp table alert_count as select count(*)::int as n from public.alerts;
select internal.alert_eval();
select is((select count(*)::int from public.alerts), (select n from alert_count),
  'evaluated again: nothing is raised twice');

-- A capture-blocked period: raised while open, and not again once it has closed.
select pg_temp.act_as(:erin);
select is(pg_temp.perm('denied', 'granted', '0'), 'tamper', 'Screen Recording revoked: Tamper');
select pg_temp.act_as_postgres();
select internal.alert_eval();
select is((select count(distinct episode)::int from public.alerts where kind = 'tamper' and user_id = :erin),
  3, 'the open period raises its alert');
select pg_temp.act_as(:erin);
select is(pg_temp.perm('granted', 'granted', '0'), 'active', 'granted again: the period closes');
select pg_temp.act_as_postgres();
select internal.alert_eval();
select is((select count(distinct episode)::int from public.alerts where kind = 'tamper' and user_id = :erin),
  3, 'the closed period is the same episode: no second alert');

select * from finish();
rollback;
