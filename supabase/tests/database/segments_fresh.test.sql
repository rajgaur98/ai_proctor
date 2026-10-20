begin;
create extension if not exists pgtap with schema extensions;

select plan(50);

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

create function pg_temp.dirty(uid uuid) returns text
language sql as $$
  select coalesce(string_agg(day::text, ',' order by day), '') from public.dirty_days where user_id = uid
$$;

-- Erin is in America/Los_Angeles, Lucas in America/Chicago.
create temp table dev as
with d as (
  insert into public.devices (org_id, user_id, platform, os_version, agent_version, hardware_hash)
  values (:org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-fresh'),
         (:org, :lucas, 'macos', '26.0', '0.1.0', 'hash-lucas-fresh') returning id, user_id
)
select id, user_id from d;

create function pg_temp.session(uid uuid, start_at timestamptz, end_at timestamptz)
returns uuid
language sql as $$
  insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
  values ('00000000-0000-4000-8000-000000000001', uid,
          (select id from dev where user_id = uid), start_at, end_at, gen_random_uuid())
  returning id
$$;

-- Erin's local date for an instant.
create function pg_temp.erin_day(t timestamptz) returns date
language sql as $$ select (t at time zone 'America/Los_Angeles')::date $$;

-- The local days from one instant to another, 'YYYY-MM-DD,...'.
create function pg_temp.days_between(a timestamptz, b timestamptz) returns text
language sql as $$
  select string_agg(d::date::text, ',' order by d)
  from generate_series(pg_temp.erin_day(a), pg_temp.erin_day(b), interval '1 day') d
$$;

-- Open days -------------------------------------------------------------------------

create temp table t0 as select clock_timestamp() - interval '3 days' as started;
create temp table open_s as select pg_temp.session(:erin, (select started from t0), null) as id;
delete from public.dirty_days;

select is(internal.mark_open_days(),
  (select count(*)::int from generate_series(pg_temp.erin_day((select started from t0)),
                                             pg_temp.erin_day(clock_timestamp()), interval '1 day')),
  'open days: every local day of an open clock session, up to today, is queued');
select is(pg_temp.dirty(:erin), pg_temp.days_between((select started from t0), clock_timestamp()),
  'open days: those are the days, start to today');

update public.dirty_days set attempts = 4, last_error = 'boom',
  next_attempt_at = clock_timestamp() + interval '1 hour'
where user_id = :erin;
select is(internal.mark_open_days(), 0, 'open days: a day already queued is left alone');
select is((select min(attempts) from public.dirty_days where user_id = :erin), 4,
  'open days: and keeps its attempts (marking it is not a new fact)');
select ok((select min(next_attempt_at) from public.dirty_days where user_id = :erin) > clock_timestamp(),
  'open days: and its backoff');

-- Rate limit and finality. Days are d0 (3 days ago) .. d3 (today).
delete from public.dirty_days;
create temp table d as
select pg_temp.erin_day((select started from t0)) + n as day, n from generate_series(0, 3) n;
insert into internal.segment_rebuilds (user_id, day, rebuilt_at)
values
  -- d0: rebuilt after it ended, long ago: final.
  (:erin, (select day from d where n = 0),
   ((select day + 1 from d where n = 0)::timestamp at time zone 'America/Los_Angeles') + interval '1 hour'),
  -- d1: rebuilt before it ended, long ago: stale.
  (:erin, (select day from d where n = 1),
   ((select day + 1 from d where n = 1)::timestamp at time zone 'America/Los_Angeles') - interval '1 hour'),
  -- d3 (today): rebuilt a minute ago: fresh enough.
  (:erin, (select day from d where n = 3), clock_timestamp() - interval '1 minute');
-- d2: never rebuilt.
select internal.mark_open_days();
select is(pg_temp.dirty(:erin), (select string_agg(day::text, ',' order by day) from d where n in (1, 2)),
  'open days: skips a past day rebuilt after it ended and a day rebuilt a minute ago, queues the rest');

delete from public.dirty_days;
update internal.segment_rebuilds set rebuilt_at = clock_timestamp() - interval '10 minutes'
where user_id = :erin and day = (select day from d where n = 3);
select internal.mark_open_days();
select ok(pg_temp.dirty(:erin) like '%' || (select day::text from d where n = 3),
  'open days: today is queued again once its last rebuild is over 4 minutes old');

delete from public.dirty_days;
create or replace function internal.day_locked(p_user_id uuid, p_day date)
returns boolean language sql as $$ select p_day = (select day from d where n = 2) $$;
select internal.mark_open_days();
select is(pg_temp.dirty(:erin), (select string_agg(day::text, ',' order by day) from d where n in (1, 3)),
  'open days: a locked day is not queued (a rebuild would only drop the mark)');
create or replace function internal.day_locked(p_user_id uuid, p_day date)
returns boolean language sql as $$ select false $$;

delete from public.dirty_days;
delete from public.clock_sessions where id = (select id from open_s);
select pg_temp.session(:lucas, clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour');
delete from public.dirty_days;
select internal.mark_open_days();
select is((select count(*)::int from public.dirty_days), 0,
  'open days: a closed session, or nobody clocked in, queues nothing');

-- replace_day_segments notes when it rebuilt.
insert into public.dirty_days (user_id, day) values (:lucas, '2026-03-16');
create temp table t1 as select clock_timestamp() as t;
select internal.replace_day_segments(:lucas, '2026-03-16', '[]'::jsonb, clock_timestamp());
select ok((select rebuilt_at >= (select t from t1) from internal.segment_rebuilds
  where user_id = :lucas and day = '2026-03-16'),
  'replace_day_segments records when the day was rebuilt');
select is(pg_temp.dirty(:lucas), '', 'replace_day_segments still clears the mark');

-- The kick: open day -> queue -> call (needs both secrets).
delete from public.dirty_days;
delete from internal.segment_rebuilds;
create temp table kick_s as select pg_temp.session(:erin, clock_timestamp() - interval '30 seconds', null) as id;
delete from public.dirty_days;
select vault.create_secret('http://example.invalid', 'project_url');
select vault.create_secret('not-a-real-key', 'service_role_key');
create temp table queued as select count(*) as n from net.http_request_queue;
select internal.segments_kick();
select ok((select count(*) from public.dirty_days where user_id = :erin) >= 1,
  'segments_kick queues the open day');
select is((select count(*) from net.http_request_queue), (select n + 1 from queued),
  'segments_kick then calls the function');

-- Only days still backing off: nothing due, no call.
update public.dirty_days set next_attempt_at = clock_timestamp() + interval '1 hour';
create temp table queued2 as select count(*) as n from net.http_request_queue;
select internal.segments_kick();
select is((select count(*) from net.http_request_queue), (select n from queued2),
  'segments_kick does not call the function while every day is backing off');
delete from public.clock_sessions where id = (select id from kick_s);
delete from public.dirty_days;
delete from internal.segment_rebuilds;

-- Backoff -------------------------------------------------------------------------------

create function pg_temp.delay_min(uid uuid, d date) returns int
language sql as $$
  select round(extract(epoch from next_attempt_at - clock_timestamp()) / 60.0)::int
  from public.dirty_days where user_id = uid and day = d
$$;

insert into public.dirty_days (user_id, day) values (:erin, '2026-04-01');
select is((select attempts from public.dirty_days where day = '2026-04-01'), 0, 'a new dirty day has no attempts');
select ok((select next_attempt_at <= clock_timestamp() from public.dirty_days where day = '2026-04-01'),
  'and is due at once');

select public.record_segment_failure(:erin, '2026-04-01', 'boom');
select is((select (attempts, last_error)::text from public.dirty_days where day = '2026-04-01'), '(1,boom)',
  'a failure counts the attempt and keeps the error');

create function pg_temp.delays(uid uuid, d date, n int) returns int[]
language plpgsql as $$
declare out int[] := '{}'; i int;
begin
  update public.dirty_days set attempts = 0 where user_id = uid and day = d;
  for i in 1..n loop
    perform public.record_segment_failure(uid, d, 'again');
    out := out || pg_temp.delay_min(uid, d);
  end loop;
  return out;
end $$;
select is(pg_temp.delays(:erin, '2026-04-01', 12),
  array[5, 10, 20, 40, 80, 160, 320, 360, 360, 360, 360, 360],
  'backoff: 5 min x 2^attempts, capped at 6 h and kept there (never dropped)');

select public.record_segment_failure(:erin, '2026-04-01', repeat('x', 5000));
select is((select char_length(last_error) from public.dirty_days where day = '2026-04-01'), 1000,
  'the stored error is cut to 1000 characters');

-- A fact marked after the attempt began is new: nothing recorded.
update public.dirty_days set attempts = 2, marked_at = clock_timestamp() where day = '2026-04-01';
select public.record_segment_failure(:erin, '2026-04-01', 'late', clock_timestamp() - interval '1 minute');
select is((select attempts from public.dirty_days where day = '2026-04-01'), 2,
  'a failure for an attempt that began before the latest mark is ignored');
select public.record_segment_failure(:erin, '2026-04-01', 'on time', clock_timestamp());
select is((select attempts from public.dirty_days where day = '2026-04-01'), 3,
  'and one for an attempt that began after it is recorded');

select public.record_segment_failure(:erin, '2026-04-02', 'no such row');
select is((select count(*)::int from public.dirty_days where day = '2026-04-02'), 0,
  'a failure for a day that is not queued does nothing');

-- A new fact resets the attempts and makes the day due again.
select internal.mark_dirty(:erin, '2026-04-01 12:00:00-07', '2026-04-01 13:00:00-07');
select is((select (attempts, next_attempt_at <= clock_timestamp())::text from public.dirty_days
  where day = '2026-04-01'), '(0,t)', 'a new fact resets the attempts and the backoff');

-- Poison pills don't starve the rest.
delete from public.dirty_days;
insert into public.dirty_days (user_id, day, marked_at, attempts, next_attempt_at)
select :erin, date '2025-01-01' + n, clock_timestamp() - interval '2 days', 3,
       clock_timestamp() + interval '1 hour'
from generate_series(1, 60) n;
insert into public.dirty_days (user_id, day) values (:erin, '2026-06-01');
select is((select array_agg(day::text) from public.due_segment_days(50)), array['2026-06-01'],
  'due_segment_days: 60 failing days in backoff do not hide a fresh one');

delete from public.dirty_days;
insert into public.dirty_days (user_id, day, marked_at, next_attempt_at)
values (:erin, '2026-07-02', clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour'),
       (:erin, '2026-07-01', clock_timestamp() - interval '3 hours', clock_timestamp() - interval '3 hours'),
       (:erin, '2026-07-03', clock_timestamp() - interval '2 hours', clock_timestamp() - interval '2 hours'),
       (:erin, '2026-07-04', clock_timestamp() - interval '4 hours', clock_timestamp() + interval '1 minute');
select is((select array_agg(day::text order by ord) from public.due_segment_days(50) with ordinality as t(user_id, day, picked_at, ord)),
  array['2026-07-01', '2026-07-03', '2026-07-02'],
  'due_segment_days: due days only, oldest first');
select is((select count(*)::int from public.due_segment_days(2)), 2, 'due_segment_days: honours the limit');
select is((select count(*)::int from public.due_segment_days(0)), 1, 'due_segment_days: at least one');
select ok((select bool_and(picked_at <= clock_timestamp()) from public.due_segment_days(50)),
  'due_segment_days: reports the database time it picked them');

-- A successful rebuild drops the row, attempts and all.
update public.dirty_days set attempts = 5, last_error = 'boom' where day = '2026-07-01';
select internal.replace_day_segments(:erin, '2026-07-01', '[]'::jsonb, clock_timestamp());
select is((select count(*)::int from public.dirty_days where day = '2026-07-01'), 0,
  'a rebuild that works clears the failing day');

-- Stuck days --------------------------------------------------------------------------

delete from public.dirty_days;
insert into public.dirty_days (user_id, day, attempts, last_error)
values (:erin, '2026-08-01', 2, 'not yet'),
       (:erin, '2026-08-02', 3, 'segment_outside_day'),
       (:lucas, '2026-08-03', 9, 'boom');
select pg_temp.act_as(:ada);
select is((select array_agg(day::text order by ord) from public.stuck_segment_days() with ordinality as t(user_id, full_name, email, day, attempts, last_error, marked_at, next_attempt_at, ord)),
  array['2026-08-03', '2026-08-02'],
  'stuck_segment_days: an admin sees days with 3 or more attempts, worst first');
select is((select (full_name, email, attempts, last_error)::text from public.stuck_segment_days() where day = '2026-08-02'),
  '("Erin Employee",erin@acme.test,3,segment_outside_day)', 'stuck_segment_days: who, how many times and why');
select pg_temp.act_as(:max);
select throws_ok($$select * from public.stuck_segment_days()$$, '42501', 'admin_only',
  'stuck_segment_days: a manager is refused');
select pg_temp.act_as(:erin);
select throws_ok($$select * from public.stuck_segment_days()$$, '42501', 'admin_only',
  'stuck_segment_days: so is an employee');
select pg_temp.act_as_postgres();
delete from public.dirty_days;

-- Access --------------------------------------------------------------------------------

select is(has_function_privilege('service_role', 'public.due_segment_days(int)', 'execute'), true,
  'due_segment_days is for the service role');
select is(has_function_privilege('authenticated', 'public.due_segment_days(int)', 'execute'), false,
  'due_segment_days is not for signed-in users');
select is(has_function_privilege('service_role', 'public.record_segment_failure(uuid, date, text, timestamptz)', 'execute'), true,
  'record_segment_failure is for the service role');
select is(has_function_privilege('authenticated', 'public.record_segment_failure(uuid, date, text, timestamptz)', 'execute')
  or has_function_privilege('anon', 'public.record_segment_failure(uuid, date, text, timestamptz)', 'execute'), false,
  'record_segment_failure is not for signed-in or anonymous users');
select is(has_function_privilege('authenticated', 'public.stuck_segment_days()', 'execute'), true,
  'stuck_segment_days is callable by signed-in users (it checks the role itself)');
select is(has_function_privilege('anon', 'public.stuck_segment_days()', 'execute'), false,
  'stuck_segment_days is not callable anonymously');
select is(has_function_privilege('authenticated', 'internal.mark_open_days(interval)', 'execute'), false,
  'mark_open_days is internal');
select is(has_table_privilege('authenticated', 'internal.segment_rebuilds', 'select'), false,
  'segment_rebuilds is not readable through the API');

-- Pauses across midnight (BRK-06) ----------------------------------------------------------

-- Erin, America/Los_Angeles (PDT from 8 March 2026). Same numbers as the golden cases
-- in packages/core/src/segments.test.ts ("pauses across midnight").
create temp table big_s as
select pg_temp.session(:erin, '2026-03-20 18:00:00-07', '2026-03-25 03:00:00-07') as id;

-- Opens and closes a pause, returns its over_cap_s.
create function pg_temp.pause(s timestamptz, e timestamptz) returns int
language plpgsql as $$
declare v uuid;
begin
  insert into public.pauses (org_id, user_id, clock_session_id, start_at, planned_min)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
          (select id from big_s), s, 15)
  returning id into v;
  perform internal.close_pause(v, e);
  return (select over_cap_s from public.pauses where id = v);
end $$;

-- 23:50 to 00:30: 10 minutes eligible on day one, 5 on day two (the first 15 of the pause).
select is(pg_temp.pause('2026-03-20 23:50:00-07', '2026-03-21 00:30:00-07'), 25 * 60,
  'close_pause: a pause across midnight counts its first 15 minutes over both days (25 min over)');

-- Day one has 55 minutes counted before the late pause, so only 5 of its 10 eligible
-- minutes fit; day two starts clean, so its 5 count.
select pg_temp.pause('2026-03-22 20:00:00-07', '2026-03-22 20:15:00-07');
select pg_temp.pause('2026-03-22 21:00:00-07', '2026-03-22 21:15:00-07');
select pg_temp.pause('2026-03-22 22:00:00-07', '2026-03-22 22:15:00-07');
select pg_temp.pause('2026-03-22 23:00:00-07', '2026-03-22 23:10:00-07');
select is(pg_temp.pause('2026-03-22 23:50:00-07', '2026-03-23 00:30:00-07'), 30 * 60,
  'close_pause: each day has its own daily cap (5 + 5 counted of 40, so 30 min over)');

select is(pg_temp.pause('2026-03-23 23:00:00-07', '2026-03-24 01:00:00-07'), 105 * 60,
  'close_pause: a long pause counts 15 minutes in total, none of it on the second day');
select is(pg_temp.pause('2026-03-24 20:00:00-07', '2026-03-24 20:10:00-07'), 0,
  'close_pause: a pause inside one day is unchanged (10 min, none over)');

-- Ends exactly at midnight: nothing leaks into the next day.
select is(pg_temp.pause('2026-03-24 23:50:00-07', '2026-03-25 00:00:00-07'), 0,
  'close_pause: a pause ending exactly at midnight is all day one');
select is(pg_temp.pause('2026-03-25 00:00:00-07', '2026-03-25 00:10:00-07'), 0,
  'close_pause: and the next day''s total is untouched by it');

-- A tighter daily cap shows the second day sharing its budget with the next pauses.
update public.orgs set policy = '{"pause_daily_max_min": 20}' where id = :org;
delete from public.pauses where user_id = :erin;
select is(pg_temp.pause('2026-03-21 23:50:00-07', '2026-03-22 00:30:00-07'), 25 * 60,
  'close_pause (daily 20): 10 + 5 counted of 40, 25 min over');
select is(pg_temp.pause('2026-03-22 00:40:00-07', '2026-03-22 00:55:00-07'), 0,
  'close_pause (daily 20): the next pause fits in the 15 minutes day two has left');
select is(pg_temp.pause('2026-03-22 01:10:00-07', '2026-03-22 01:20:00-07'), 10 * 60,
  'close_pause (daily 20): and the one after finds the day used up');
update public.orgs set policy = '{}' where id = :org;

select * from finish();
rollback;
