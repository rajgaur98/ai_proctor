begin;
create extension if not exists pgtap with schema extensions;

select plan(52);

\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
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

-- The days marked dirty for a user since the last reset, as 'YYYY-MM-DD,...'.
create function pg_temp.dirty(uid uuid) returns text
language sql as $$
  select coalesce(string_agg(day::text, ',' order by day), '') from public.dirty_days where user_id = uid
$$;

create function pg_temp.reset_dirty() returns void
language sql as $$ delete from public.dirty_days $$;

create function pg_temp.epoch(t timestamptz) returns bigint
language sql as $$ select extract(epoch from t)::bigint $$;

-- Erin is in America/Los_Angeles, Lucas in America/Chicago. March 8 2026 is when
-- the US moved to daylight time, so afterwards PDT = -07 and CDT = -05.
create temp table dev as
with d as (
  insert into public.devices (org_id, user_id, platform, os_version, agent_version, hardware_hash)
  values (:org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-segments') returning id
)
select id as erin_device from d;
create temp table dev2 as
with d as (
  insert into public.devices (org_id, user_id, platform, os_version, agent_version, hardware_hash)
  values (:org, :lucas, 'macos', '26.0', '0.1.0', 'hash-lucas-segments') returning id
)
select id as lucas_device from d;

create function pg_temp.session(uid uuid, start_at timestamptz, end_at timestamptz)
returns uuid
language sql as $$
  insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
  values ('00000000-0000-4000-8000-000000000001', uid,
          case when uid = '00000000-0000-4000-8000-0000000000c1'
               then (select erin_device from dev) else (select lucas_device from dev2) end,
          start_at, end_at, gen_random_uuid())
  returning id
$$;

-- Dirty marking ---------------------------------------------------------------------

-- A night shift (22:00 to 06:00) touches two local days.
create temp table s1 as select pg_temp.session(:erin, '2026-03-10 22:00:00-07', '2026-03-11 06:00:00-07') as id;
select is(pg_temp.dirty(:erin), '2026-03-10,2026-03-11', 'clock session: a night shift marks both local days');

select pg_temp.reset_dirty();
select pg_temp.session(:erin, '2026-03-12 09:00:00-07', '2026-03-12 17:00:00-07');
select is(pg_temp.dirty(:erin), '2026-03-12', 'clock session: a day shift marks one day');

select pg_temp.reset_dirty();
select pg_temp.session(:erin, '2026-03-12 20:00:00-07', '2026-03-13 00:00:00-07');
select is(pg_temp.dirty(:erin), '2026-03-12', 'clock session ending exactly at midnight does not touch the next day');

select pg_temp.reset_dirty();
select pg_temp.session(:lucas, '2026-03-11 06:00:00+00', '2026-03-11 06:30:00+00');
select is(pg_temp.dirty(:lucas), '2026-03-11', 'days are the employee''s own: 01:00 CDT is already March 11');
select pg_temp.reset_dirty();
select pg_temp.session(:erin, '2026-03-11 06:00:00+00', '2026-03-11 06:30:00+00');
select is(pg_temp.dirty(:erin), '2026-03-10', 'the same instant is still March 10 for Erin (23:00 PDT)');

select pg_temp.reset_dirty();
create temp table s2 as select pg_temp.session(:erin, '2026-03-20 09:00:00-07', '2026-03-20 17:00:00-07') as id;
select pg_temp.reset_dirty();
update public.clock_sessions set end_at = '2026-03-21 02:00:00-07' where id = (select id from s2);
select is(pg_temp.dirty(:erin), '2026-03-20,2026-03-21', 'clock session update: the new range is marked');

select pg_temp.reset_dirty();
update public.clock_sessions set end_at = '2026-03-20 18:00:00-07' where id = (select id from s2);
select is(pg_temp.dirty(:erin), '2026-03-20,2026-03-21', 'clock session update: the old range is marked too');

select pg_temp.reset_dirty();
delete from public.clock_sessions where user_id = :erin and start_at >= '2026-03-12' and start_at < '2026-03-14';
select pg_temp.reset_dirty();
create temp table open_session as
select pg_temp.session(:erin, now() - interval '3 days', null) as id;
select is(
  pg_temp.dirty(:erin),
  (select string_agg(d::date::text, ',' order by d)
   from generate_series(((now() - interval '3 days') at time zone 'America/Los_Angeles')::date,
                        (now() at time zone 'America/Los_Angeles')::date, interval '1 day') d),
  'an open clock session marks every day up to now');
delete from public.clock_sessions where id = (select id from open_session);

select pg_temp.reset_dirty();
insert into public.breaks (org_id, user_id, clock_session_id, start_at, end_at, planned_min)
values (:org, :erin, (select id from s1), '2026-03-10 23:00:00-07', '2026-03-10 23:30:00-07', 30);
select is(pg_temp.dirty(:erin), '2026-03-10', 'break marks its day');

select pg_temp.reset_dirty();
insert into public.pauses (org_id, user_id, clock_session_id, start_at, end_at, planned_min)
values (:org, :erin, (select id from s1), '2026-03-10 23:55:00-07', '2026-03-11 00:05:00-07', 10);
select is(pg_temp.dirty(:erin), '2026-03-10,2026-03-11', 'a pause across midnight marks both days');

select pg_temp.reset_dirty();
insert into public.status_periods (org_id, user_id, status, start_at, end_at)
values (:org, :erin, 'idle', '2026-03-11 01:00:00-07', '2026-03-11 01:20:00-07');
select is(pg_temp.dirty(:erin), '2026-03-11', 'status period marks its day');

select pg_temp.reset_dirty();
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome)
values (gen_random_uuid(), :org, :erin, (select erin_device from dev),
        '2026-03-12 23:59:00-07', '2026-03-13 00:00:05-07', 'miss');
select is(pg_temp.dirty(:erin), '2026-03-13', 'check-in counts from when its card was shown');

select pg_temp.reset_dirty();
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome)
values (gen_random_uuid(), :org, :erin, (select erin_device from dev), '2026-03-14 08:00:00-07', null, 'pass');
select is(pg_temp.dirty(:erin), '2026-03-14', 'check-in never shown counts from its scheduled time');

-- Raw events: only project switches mark days. A switch applies to the end of its
-- clock session (S2 runs into March 21).
select internal.ensure_weekly_partitions('public.agent_events_raw', '2026-03-09', '2026-03-23');
create function pg_temp.raw(type text, at timestamptz) returns void
language sql as $$
  insert into public.agent_events_raw (id, org_id, device_id, user_id, seq, type, at, payload)
  values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', (select erin_device from dev),
          '00000000-0000-4000-8000-0000000000c1', 1, type, at, '{"project_id": null}')
$$;

select pg_temp.reset_dirty();
select pg_temp.raw('lock', '2026-03-20 10:00:00-07');
select is(pg_temp.dirty(:erin), '', 'other raw events mark nothing');

select pg_temp.raw('project_switch', '2026-03-20 10:00:00-07');
select is(pg_temp.dirty(:erin), '2026-03-20', 'project switch marks its day');

update public.clock_sessions set end_at = '2026-03-21 02:00:00-07' where id = (select id from s2);
select pg_temp.reset_dirty();
select pg_temp.raw('project_switch', '2026-03-20 20:00:00-07');
select is(pg_temp.dirty(:erin), '2026-03-20,2026-03-21', 'project switch marks the days to the end of its clock session');

-- segment_inputs -------------------------------------------------------------------------

-- One employee-day in full: March 16, 09:00 to 17:00 PDT.
select pg_temp.reset_dirty();
create temp table s3 as select pg_temp.session(:erin, '2026-03-16 09:00:00-07', '2026-03-16 17:00:00-07') as id;
insert into public.breaks (org_id, user_id, clock_session_id, start_at, end_at, planned_min)
values (:org, :erin, (select id from s3), '2026-03-16 12:00:00-07', '2026-03-16 12:30:00-07', 30);
insert into public.pauses (org_id, user_id, clock_session_id, start_at, end_at, planned_min)
values (:org, :erin, (select id from s3), '2026-03-16 14:00:00-07', '2026-03-16 14:10:00-07', 10);
insert into public.status_periods (org_id, user_id, status, start_at, end_at)
values (:org, :erin, 'idle', '2026-03-16 10:00:00-07', '2026-03-16 10:20:00-07'),
       (:org, :erin, 'active', '2026-03-16 10:20:00-07', null);
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome)
values (gen_random_uuid(), :org, :erin, (select erin_device from dev), '2026-03-16 11:00:00-07', '2026-03-16 11:00:03-07', 'miss'),
       (gen_random_uuid(), :org, :erin, (select erin_device from dev), '2026-03-16 11:30:00-07', null, 'pass'),
       -- Yesterday, before this shift: not an input.
       (gen_random_uuid(), :org, :erin, (select erin_device from dev), '2026-03-15 11:00:00-07', null, 'miss');
select pg_temp.raw('project_switch', '2026-03-16 13:00:00-07');
-- Another day's facts: not inputs.
select pg_temp.session(:erin, '2026-03-17 09:00:00-07', '2026-03-17 10:00:00-07');
select pg_temp.session(:erin, '2026-03-15 09:00:00-07', '2026-03-15 10:00:00-07');

create temp table inp as select public.segment_inputs(:erin, '2026-03-16') as r;
select is(
  (select array_agg(k order by k) from jsonb_object_keys((select r from inp) -> 'input') k),
  array['breaks', 'checkins', 'clockSessions', 'day', 'manualEntries', 'now', 'pauses', 'policy',
        'projectEdits', 'projectSwitches', 'statusPeriods'],
  'segment_inputs: exactly the DayInput fields');
select is(((select r from inp) -> 'input' -> 'day'),
  jsonb_build_object('start', pg_temp.epoch('2026-03-16 00:00:00-07'), 'end', pg_temp.epoch('2026-03-17 00:00:00-07')),
  'segment_inputs: day bounds are Erin''s local midnight to midnight, in Unix seconds');
select is(((select r from inp) -> 'input' -> 'clockSessions'),
  jsonb_build_array(jsonb_build_object('start', pg_temp.epoch('2026-03-16 09:00:00-07'),
    'end', pg_temp.epoch('2026-03-16 17:00:00-07'), 'projectId', null)),
  'segment_inputs: only that day''s clock session, no project');
select is(((select r from inp) -> 'input' -> 'breaks'),
  jsonb_build_array(jsonb_build_object('start', pg_temp.epoch('2026-03-16 12:00:00-07'),
    'end', pg_temp.epoch('2026-03-16 12:30:00-07'))),
  'segment_inputs: breaks');
select is(((select r from inp) -> 'input' -> 'pauses'),
  jsonb_build_array(jsonb_build_object('start', pg_temp.epoch('2026-03-16 14:00:00-07'),
    'end', pg_temp.epoch('2026-03-16 14:10:00-07'))),
  'segment_inputs: pauses');
select is(((select r from inp) -> 'input' -> 'statusPeriods'),
  jsonb_build_array(
    jsonb_build_object('status', 'idle', 'start', pg_temp.epoch('2026-03-16 10:00:00-07'), 'end', pg_temp.epoch('2026-03-16 10:20:00-07')),
    jsonb_build_object('status', 'active', 'start', pg_temp.epoch('2026-03-16 10:20:00-07'), 'end', null)),
  'segment_inputs: status periods, the open one with a null end');
select is(((select r from inp) -> 'input' -> 'checkins'),
  jsonb_build_array(
    jsonb_build_object('at', pg_temp.epoch('2026-03-16 11:00:03-07'), 'outcome', 'miss'),
    jsonb_build_object('at', pg_temp.epoch('2026-03-16 11:30:00-07'), 'outcome', 'pass')),
  'segment_inputs: check-ins by shown time (else scheduled), not the previous shift''s');
select is(((select r from inp) -> 'input' -> 'projectSwitches'),
  -- taskId (#268): the switch's task when it is the project's, else null.
  jsonb_build_array(jsonb_build_object('at', pg_temp.epoch('2026-03-16 13:00:00-07'), 'projectId', null,
    'taskId', null)),
  'segment_inputs: project switches from the raw events');
select is(((select r from inp) -> 'input' -> 'policy'),
  '{"breaksPaid": false, "pauseMaxS": 900, "pauseDailyMaxS": 3600}'::jsonb,
  'segment_inputs: policy defaults are 15 and 60 minutes, breaks unpaid');
select ok(((select r from inp) ->> 'loaded_at')::timestamptz <= clock_timestamp()
  and ((select r from inp) -> 'input' ->> 'now')::bigint <= extract(epoch from clock_timestamp()),
  'segment_inputs: loaded_at and now are the load time');

update public.orgs set policy = '{"breaks_paid": true, "pause_max_min": 5, "pause_daily_max_min": 20}' where id = :org;
select is(public.segment_inputs(:erin, '2026-03-16') -> 'input' -> 'policy',
  '{"breaksPaid": true, "pauseMaxS": 300, "pauseDailyMaxS": 1200}'::jsonb,
  'segment_inputs: policy comes from the org');
update public.orgs set policy = '{}' where id = :org;

-- A shift running past midnight: the next day sees it, plus the check-ins from its
-- start (an unverified stretch carries over) but not older ones.
select pg_temp.session(:erin, '2026-03-18 22:00:00-07', '2026-03-19 02:00:00-07');
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome)
values (gen_random_uuid(), :org, :erin, (select erin_device from dev), '2026-03-18 23:00:00-07', null, 'miss'),
       (gen_random_uuid(), :org, :erin, (select erin_device from dev), '2026-03-18 10:00:00-07', null, 'miss');
select is(
  jsonb_array_length(public.segment_inputs(:erin, '2026-03-19') -> 'input' -> 'checkins'), 1,
  'segment_inputs: the miss from before midnight, in the same shift, carries over');
select is(
  public.segment_inputs(:erin, '2026-03-19') -> 'input' -> 'clockSessions' -> 0 ->> 'start',
  pg_temp.epoch('2026-03-18 22:00:00-07')::text,
  'segment_inputs: the overnight session is an input of both days');

-- replace_day_segments ----------------------------------------------------------------

create function pg_temp.seg(type text, start_at timestamptz, end_at timestamptz) returns jsonb
language sql as $$
  select jsonb_build_object('start', pg_temp.epoch(start_at), 'end', pg_temp.epoch(end_at),
    'type', type, 'project_id', null, 'counted', true, 'flagged', type = 'idle')
$$;

insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged, source)
values (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 12:00:00-07', 'verified', true, false, 'auto'),
       (:org, :erin, '2026-03-16', '2026-03-16 12:00:00-07', '2026-03-16 13:00:00-07', 'manual', true, false, 'manual'),
       (:org, :erin, '2026-03-17', '2026-03-17 09:00:00-07', '2026-03-17 10:00:00-07', 'verified', true, false, 'auto');
delete from public.dirty_days;
insert into public.dirty_days (user_id, day, marked_at)
values (:erin, '2026-03-16', now() - interval '1 minute'), (:erin, '2026-03-17', now() - interval '1 minute');

select is(
  internal.replace_day_segments(:erin, '2026-03-16',
    jsonb_build_array(pg_temp.seg('verified', '2026-03-16 09:00:00-07', '2026-03-16 10:00:00-07'),
                      pg_temp.seg('idle', '2026-03-16 10:00:00-07', '2026-03-16 10:20:00-07')),
    clock_timestamp()),
  2, 'replace_day_segments: returns how many segments it wrote');
select is(
  (select array_agg(type || ':' || source order by start_at) from public.time_segments
   where user_id = :erin and day = '2026-03-16'),
  array['verified:auto', 'idle:auto', 'manual:manual'],
  'replace_day_segments: auto segments replaced, the manual-source one kept');
select is(
  (select count(*)::int from public.time_segments where user_id = :erin and day = '2026-03-17'), 1,
  'replace_day_segments: other days untouched');
select is(pg_temp.dirty(:erin), '2026-03-17', 'replace_day_segments: clears the rebuilt day''s dirty mark only');
select is(
  (select (flagged, to_char(start_at at time zone 'UTC', 'HH24:MI'), to_char(end_at at time zone 'UTC', 'HH24:MI'))::text
   from public.time_segments where user_id = :erin and day = '2026-03-16' and type = 'idle'),
  '(t,17:00,17:20)', 'replace_day_segments: stores Unix seconds as timestamptz');

-- A fact marked after the facts were loaded keeps its mark (rebuilt again next round).
update public.dirty_days set marked_at = clock_timestamp() where user_id = :erin and day = '2026-03-17';
select internal.replace_day_segments(:erin, '2026-03-17', '[]'::jsonb, now() - interval '1 minute');
select is(pg_temp.dirty(:erin), '2026-03-17', 'replace_day_segments: a mark newer than the load survives');
select internal.replace_day_segments(:erin, '2026-03-17', '[]'::jsonb, clock_timestamp());
select is(pg_temp.dirty(:erin), '', 'replace_day_segments: and goes with the next rebuild');

select throws_ok(
  $$select internal.replace_day_segments('00000000-0000-4000-8000-0000000000c1', '2026-03-16',
    jsonb_build_array(pg_temp.seg('verified', '2026-03-15 23:00:00-07', '2026-03-16 01:00:00-07')),
    clock_timestamp())$$,
  '22023', 'segment_outside_day', 'replace_day_segments: a segment crossing the day boundary is refused');
select is(
  (select count(*)::int from public.time_segments where user_id = :erin and day = '2026-03-16' and source = 'auto'), 2,
  'replace_day_segments: and the failed call changed nothing');

-- A locked day (stubbed here: #43 supplies the real check) is left alone.
create or replace function internal.day_locked(p_user_id uuid, p_day date)
returns boolean language sql as $$ select p_day = '2026-03-16' $$;
insert into public.dirty_days (user_id, day) values (:erin, '2026-03-16');
select is(
  internal.replace_day_segments(:erin, '2026-03-16', '[]'::jsonb, clock_timestamp()), null,
  'locked day: replace_day_segments does nothing and returns null');
select is(
  (select count(*)::int from public.time_segments where user_id = :erin and day = '2026-03-16' and source = 'auto'), 2,
  'locked day: its segments are untouched');
select is(pg_temp.dirty(:erin), '', 'locked day: nothing to rebuild, the mark is dropped');
create or replace function internal.day_locked(p_user_id uuid, p_day date)
returns boolean language sql as $$ select false $$;

-- Access ---------------------------------------------------------------------------------

select is(has_function_privilege('authenticated', 'public.segment_inputs(uuid, date)', 'execute'), false,
  'segment_inputs is not callable by signed-in users');
select is(has_function_privilege('service_role', 'public.replace_day_segments(uuid, date, jsonb, timestamptz)', 'execute'), true,
  'replace_day_segments is for the service role');

select pg_temp.act_as(:max);
select is((select count(*)::int from public.time_segments where user_id = :erin), 3,
  'RLS: the manager sees a report''s segments');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.time_segments where user_id = :erin), 0, 'RLS: a peer sees none');
select pg_temp.act_as(:erin);
select is((select count(*)::int from public.time_segments), 3, 'RLS: an employee sees their own');
select throws_ok($$select * from public.dirty_days$$, '42501', null, 'dirty_days is not readable through the API');
select pg_temp.act_as_postgres();

-- Cron --------------------------------------------------------------------------------

select is((select schedule from cron.job where jobname = 'segments_kick'), '*/5 * * * *',
  'segments_kick runs every 5 minutes');

insert into public.dirty_days (user_id, day) values (:erin, '2026-03-16');
create temp table queued as select count(*) as n from net.http_request_queue;
select internal.segments_kick();
select is((select count(*) from net.http_request_queue), (select n from queued),
  'segments_kick does nothing without the Vault secrets');

select vault.create_secret('http://example.invalid', 'project_url');
select internal.segments_kick();
select is((select count(*) from net.http_request_queue), (select n from queued),
  'segments_kick does nothing with only one secret');

select vault.create_secret('not-a-real-key', 'service_role_key');
select internal.segments_kick();
select is((select count(*) from net.http_request_queue), (select n + 1 from queued),
  'segments_kick posts to the function when both secrets are set');

delete from public.dirty_days;
select internal.segments_kick();
select is((select count(*) from net.http_request_queue), (select n + 1 from queued),
  'segments_kick does nothing when no day is dirty');

select * from finish();
rollback;
